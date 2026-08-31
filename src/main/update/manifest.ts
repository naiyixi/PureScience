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

const isDownload = (value: unknown): value is PlatformDownload => {
  const d = value as PlatformDownload
  if (
    !d ||
    typeof d.url !== 'string' ||
    typeof d.size !== 'number' ||
    typeof d.sha256 !== 'string'
  ) {
    return false
  }
  let parsed: URL
  try {
    parsed = new URL(d.url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:') return false
  return isAllowedDownloadHost(parsed.hostname)
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
    throw new Error('Invalid update manifest')
  }
  for (const [key, value] of Object.entries(m.downloads)) {
    if (!isDownload(value)) throw new Error(`Invalid download entry: ${key}`)
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
  const response = await fetchImpl(url, {
    headers: { Accept: 'application/json' },
    // A hung manifest fetch must not block the update flow forever.
    signal: AbortSignal.timeout(10_000)
  })
  if (!response.ok) throw new Error(`Manifest fetch failed: ${response.status}`)
  return parseManifest(await response.json())
}
