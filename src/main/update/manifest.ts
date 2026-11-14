import { netFetchStandard } from '../skills/net-fetch'
import type { PlatformDownload, UpdateManifest } from '../../shared/update'

// Download URL source allowlist: the update flow may only fetch artifacts from these hosts. This
// hardens the manifest against tampering — a compromised CDN payload pointing the download at an
// arbitrary URL (e.g. a lookalike domain or file host) is rejected before any bytes are fetched.
const ALLOWED_DOWNLOAD_HOSTS = new Set([
  'purescience.work',
  'github.com',
  'api.github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'codeload.github.com'
])

// Accepts the host of a download URL, normalizing away subdomains that belong to GitHub's release
// asset delivery (the exact subdomain varies by region/cache tier).
const isAllowedDownloadHost = (host: string): boolean => {
  if (ALLOWED_DOWNLOAD_HOSTS.has(host)) return true
  if (host.endsWith('.githubusercontent.com')) return true
  if (host.endsWith('.purescience.work')) return true
  return false
}

const isDownloadUrlShape = (value: unknown): boolean => {
  const d = value as PlatformDownload
  if (
    !d ||
    typeof d.url !== 'string' ||
    typeof d.size !== 'number' ||
    typeof d.sha256 !== 'string'
  ) {
    return false
  }
  try {
    return new URL(d.url).protocol === 'https:'
  } catch {
    return false
  }
}

const isDownload = (value: unknown): value is PlatformDownload => {
  if (!isDownloadUrlShape(value)) return false
  const parsed = new URL((value as PlatformDownload).url)
  return isAllowedDownloadHost(parsed.hostname)
}

/**
 * Why an update check failed. Closed on purpose: the failure line is the only thing a later reader (or a
 * support bundle) can act on, and a free-text message would carry URLs and echoed payload bytes into the
 * log. Before this existed, an HTTP error, an unparseable feed and a transport failure all landed as
 * `errorCategory: 'error'` — the same reading — and the 2026-11-12 field investigation could not tell a
 * broken feed from a network that changed mid-request without reproducing the run.
 *
 * `transport` is the only class whose detail lives elsewhere: the logger classifies the Chromium token
 * (`net::ERR_*`) into `errorCategory`, so the two fields together name the failure without copying a
 * message.
 */
export type UpdateCheckFailureCause =
  'http-status' | 'invalid-manifest' | 'transport' | 'deadline' | 'unclassified'

/** Which rule refused the payload — a shape error and a disallowed download host are different repairs. */
export type UpdateManifestProblem = 'shape' | 'download-entry' | 'download-host'

export class UpdateManifestError extends Error {
  readonly failureCause: UpdateCheckFailureCause
  readonly httpStatus?: number
  readonly manifestProblem?: UpdateManifestProblem

  constructor(
    failureCause: UpdateCheckFailureCause,
    message: string,
    extra: { httpStatus?: number; manifestProblem?: UpdateManifestProblem; cause?: unknown } = {}
  ) {
    super(message, extra.cause === undefined ? undefined : { cause: extra.cause })
    // Deliberately left as `Error`: the logger classifies an error by `name` (and by any `net::ERR_*` token
    // in the message), so renaming the class here would turn every wrapped failure into `errorCategory:
    // 'object'` — a strictly worse reading than the `'error'` it replaced. The class is carried by
    // `failureCause` instead.
    this.failureCause = failureCause
    if (extra.httpStatus !== undefined) this.httpStatus = extra.httpStatus
    if (extra.manifestProblem !== undefined) this.manifestProblem = extra.manifestProblem
  }
}

/** Fields a failure line may carry. Never the message: it can hold a URL or payload bytes. */
export const describeUpdateFailure = (
  error: unknown
): {
  failureCause: UpdateCheckFailureCause
  httpStatus?: number
  manifestProblem?: UpdateManifestProblem
} => {
  if (error instanceof UpdateManifestError) {
    return {
      failureCause: error.failureCause,
      ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }),
      ...(error.manifestProblem === undefined ? {} : { manifestProblem: error.manifestProblem })
    }
  }
  // The check's own ceiling and the request's AbortSignal both surface as an aborted/timed-out error
  // without a `net::ERR_*` token, so they would otherwise read as an unnamed failure.
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
    return { failureCause: 'deadline' }
  }
  return { failureCause: 'unclassified' }
}

// Validates the untrusted CDN payload into a typed manifest. releaseDate/notes are optional in
// practice, so they default to '' rather than failing the whole check.
export const parseManifest = (data: unknown): UpdateManifest => {
  const m = data as UpdateManifest
  if (
    !m ||
    typeof m.version !== 'string' ||
    typeof m.downloads !== 'object' ||
    m.downloads === null
  ) {
    throw new UpdateManifestError('invalid-manifest', 'Invalid update manifest', {
      manifestProblem: 'shape'
    })
  }
  for (const [key, value] of Object.entries(m.downloads)) {
    if (!isDownload(value)) {
      const parsedOk = isDownloadUrlShape(value)
      throw new UpdateManifestError(
        'invalid-manifest',
        `Invalid download entry: ${key}`,
        // A well-shaped entry that only fails the host allowlist is a different repair (publish moved to a
        // host the client does not trust) from a missing or non-https URL.
        { manifestProblem: parsedOk ? 'download-host' : 'download-entry' }
      )
    }
  }
  return {
    version: m.version,
    releaseDate: typeof m.releaseDate === 'string' ? m.releaseDate : '',
    // Localized notes: a plain string (legacy) or { zh, en } keyed by interface language.
    notes:
      typeof m.notes === 'string'
        ? m.notes
        : typeof m.notes === 'object' && m.notes !== null
          ? m.notes
          : '',
    downloads: m.downloads
  }
}

export const fetchManifest = async (
  url: string,
  // Default to the proxy-aware net.fetch so the manifest request honors the system/VPN proxy,
  // matching the installer download and language-pack fetch. Node's global fetch bypasses it.
  fetchImpl: typeof fetch = netFetchStandard
): Promise<UpdateManifest> => {
  let response: Response
  try {
    response = await fetchImpl(url, {
      headers: { Accept: 'application/json' },
      // A hung manifest fetch must not block the update flow forever.
      signal: AbortSignal.timeout(10_000)
    })
  } catch (error) {
    // Preserve the original message: the renderer shows it verbatim, so wrapping must not replace a message
    // the user can act on ("offline") with a generic one. The classification rides on the error object.
    const message = error instanceof Error ? error.message : 'Manifest fetch failed'
    // The feed was never reached (offline, DNS, proxy off, network changed mid-request). The request's own
    // abort stays `deadline` so a 10 s ceiling is not reported as an unreachable host.
    throw error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
      ? new UpdateManifestError('deadline', message, { cause: error })
      : new UpdateManifestError('transport', message, { cause: error })
  }
  if (!response.ok) {
    throw new UpdateManifestError('http-status', `Manifest fetch failed: ${response.status}`, {
      httpStatus: response.status
    })
  }
  let payload: unknown
  try {
    payload = await response.json()
  } catch (error) {
    // A 200 that is not JSON is a feed problem (a captive portal / proxy error page), not a transport one.
    throw new UpdateManifestError(
      'invalid-manifest',
      error instanceof Error ? error.message : 'Manifest payload was not JSON',
      { manifestProblem: 'shape', cause: error }
    )
  }
  return parseManifest(payload)
}
