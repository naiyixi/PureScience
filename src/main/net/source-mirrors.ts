// Mirror fallback for content downloads — the table is EVIDENCE, not inference.
//
// P0-8 measured what actually works from this network (`docs/evidence/2026-10-11-mirror-candidate-identity-probe.md`),
// and the measurement refuted the plausible-looking pairs:
//   • `ftp.wwpdb.org` as a fallback for `files.rcsb.org` — DNS does not even resolve here (HTTP 000).
//   • `ftp.ncbi.nlm.nih.gov` as a fallback for `eutils.ncbi.nlm.nih.gov` — different services (file tree vs API).
// So this table contains ONLY the pairs that were observed to work, plus an explicit never-mirror list.
//
// The one invariant that makes a fallback acceptable at all: the caller must hold a digest for the file it asked
// for. Every candidate below is a third party (or a CDN), so "same URL shape" proves nothing about the bytes —
// a mirror that serves a *different* file would silently replace a loud failure with quiet wrong data. With a
// digest, the content identity is checked by the download itself, and a mirrored download that does not match
// fails exactly like an origin one. NO DIGEST ⇒ NO FALLBACK: we would rather report the named origin failure.

import { rm } from 'node:fs/promises'

import { resilientDownload, type ResilientDownloadOpts } from './resilient-download'

export type MirrorCandidate = {
  url: string
  /** The host the bytes would actually come from (what a `via:` marker must name). */
  host: string
}

// Hosts whose failure must stay a failure: credential-bearing endpoints. Falling back would hand a key or a
// billable request to a third party, and the user would never see it happen.
const NEVER_MIRROR_HOSTS = ['api.anthropic.com', 'api.deepseek.com']

// Release-asset proxies, in the order they should be tried. Measured 2026-10-17 on a 2 MB range of the
// shipped weight asset: `gh-proxy.com` 1394 KB/s, `ghfast.top` 536 KB/s, direct origin 139 KB/s. Their
// bytes for the same release file matched the origin's `sha256` exactly (identity is checked per download
// by the caller's digest — the table only decides who gets asked second).
// Refuted the same day and therefore NOT in the table: `ghproxy.net` (30 s timeout, 32 KB/s on a 2 MB
// range), `hub.gitmirror.com` (DNS does not resolve here), `gh.llkk.cc` (connect timeout).
const GITHUB_RELEASE_PROXIES = ['https://gh-proxy.com', 'https://ghfast.top'] as const

/** `/<owner>/<repo>/releases/download/<tag>/<file>` — the only GitHub shape whose bytes we can verify. */
const GITHUB_RELEASE_ASSET_PATH = /^\/[^/]+\/[^/]+\/releases\/download\/[^/]+\/.+$/

type MirrorRule = {
  from: string
  /** Candidate URLs for this request, in the order to try them; empty when this URL is not mirrorable. */
  rewrite: (url: URL) => string[]
}

// Observed working, 2026-10-11: origin timed out (HTTP 000 after 25 s), mirror answered 200.
const MIRROR_RULES: MirrorRule[] = [
  {
    from: 'huggingface.co',
    rewrite: (url) => [`https://hf-mirror.com${url.pathname}${url.search}`]
  },
  {
    from: 'raw.githubusercontent.com',
    // raw:  /<owner>/<repo>/<ref>/<path...>   →  cdn.jsdelivr.net/gh/<owner>/<repo>@<ref>/<path...>
    // Measured: jsDelivr's bytes for a repo file were identical to the local working copy (sha256 match).
    rewrite: (url) => {
      const parts = url.pathname.split('/').filter(Boolean)
      if (parts.length < 4) return []
      const [owner, repo, ref, ...rest] = parts
      return [`https://cdn.jsdelivr.net/gh/${owner}/${repo}@${ref}/${rest.join('/')}${url.search}`]
    }
  },
  {
    from: 'github.com',
    // Release assets only. This is the one GitHub URL shape whose bytes the caller can check against a
    // published digest (our weight manifest carries one); a repo page or an API call has nothing to verify
    // against, and a query string could be carrying a token — both are left alone rather than guessed at.
    rewrite: (url) => {
      if (!GITHUB_RELEASE_ASSET_PATH.test(url.pathname)) return []
      if (url.search !== '' || url.username !== '' || url.password !== '') return []
      return GITHUB_RELEASE_PROXIES.map((prefix) => `${prefix}/https://github.com${url.pathname}`)
    }
  }
]

export const mirrorCandidatesFor = (rawUrl: string): MirrorCandidate[] => {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return []
  }
  if (NEVER_MIRROR_HOSTS.includes(url.hostname)) return []
  return MIRROR_RULES.filter((rule) => rule.from === url.hostname)
    .flatMap((rule) => rule.rewrite(url))
    .map((candidate) => ({ url: candidate, host: new URL(candidate).hostname }))
}

export type MirrorFallbackResult = {
  path: string
  /** Where the bytes actually came from — 'origin', or the candidate's host. */
  via: string
}

export type MirrorDownloadOptions = {
  /** Injecting the download lets tests drive both hops without a network. */
  download?: typeof resilientDownload
  removeFile?: (path: string) => Promise<void>
}

/**
 * Downloads from the origin; on failure retries the mirror candidates — but only when the caller supplied a
 * digest, since that digest is the only thing standing between "the right bytes from a third party" and
 * "unknown bytes that replaced a real error".
 */
export const downloadWithMirrorFallback = async (
  url: string,
  destPath: string,
  opts: ResilientDownloadOpts,
  options: MirrorDownloadOptions = {}
): Promise<MirrorFallbackResult> => {
  const download = options.download ?? resilientDownload
  const remove = options.removeFile ?? (async (path: string) => rm(path, { force: true }))

  try {
    return { path: await download(url, destPath, opts), via: 'origin' }
  } catch (originError) {
    const candidates = opts.expectedSha256 ? mirrorCandidatesFor(url) : []
    if (candidates.length === 0) throw originError

    // The failed attempt may have left a partial file for THIS origin's bytes. Resuming it against a
    // different server would splice two sources into one file, so the partial is dropped first.
    await remove(`${destPath}.part`).catch(() => undefined)

    let lastError: unknown = originError
    for (const candidate of candidates) {
      try {
        return { path: await download(candidate.url, destPath, opts), via: candidate.host }
      } catch (candidateError) {
        lastError = candidateError
        await remove(`${destPath}.part`).catch(() => undefined)
      }
    }
    throw lastError
  }
}

/** One streaming attempt: pulls `url` into `destPath` (creating or truncating it). */
export type StreamAttempt = (url: string, destPath: string) => Promise<void>

/**
 * The streaming twin of `downloadWithMirrorFallback`: same rule, applied at the layer where the bytes
 * land on disk instead of going through the resumable downloader.
 *
 * The digest is not optional decoration here — it is the whole reason a fallback is allowed at all. With
 * one, a mirror that serves different bytes fails exactly as loudly as the origin (the caller hashes the
 * landed file right after this returns); without one, we report the origin's failure and never try a
 * third party.
 */
export const streamWithMirrorFallback = async (
  url: string,
  destPath: string,
  opts: { expectedSha256?: string },
  deps: { stream: StreamAttempt; removeFile?: (path: string) => Promise<void> }
): Promise<MirrorFallbackResult> => {
  const remove = deps.removeFile ?? (async (path: string) => rm(path, { force: true }))

  try {
    await deps.stream(url, destPath)
    return { path: destPath, via: 'origin' }
  } catch (originError) {
    const candidates = opts.expectedSha256 ? mirrorCandidatesFor(url) : []
    if (candidates.length === 0) throw originError

    // Whatever the failed attempt wrote belongs to the origin's byte stream. Gluing a mirror's bytes onto
    // it would splice two sources into one file, so the partial is dropped before the source changes.
    await remove(destPath).catch(() => undefined)

    let lastError: unknown = originError
    for (const candidate of candidates) {
      try {
        await deps.stream(candidate.url, destPath)
        return { path: destPath, via: candidate.host }
      } catch (candidateError) {
        lastError = candidateError
        await remove(destPath).catch(() => undefined)
      }
    }
    throw lastError
  }
}
