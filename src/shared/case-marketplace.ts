// The case marketplace is an index document plus one archive per case — nothing else. There is no server to trust:
// the index is a file published as a GitHub Release asset, and every archive it points at is pinned by SHA-256 in
// that same document. So the reader's job is narrow and strict: reject anything it cannot read as an index, and
// refuse an entry whose archive is not pinned.
//
// Deliberately absent: a rating, a download count, a "featured" flag. Everything here is either authored by the
// publisher (name, summary, author, licence) or measurable from the archive itself (file count, bytes, digest).

export const CASE_MARKETPLACE_FORMAT = 'purescience.case-marketplace'
export const CASE_MARKETPLACE_VERSION = 1
export const CASE_MARKETPLACE_CASE_LIMIT = 500
export const CASE_MARKETPLACE_INDEX_BYTES_LIMIT = 2 * 1024 * 1024

/**
 * The shelf lives in this repository's own releases: the index is an asset of a `case-index` release, and every
 * archive it names is an asset of that same release. Publishing a case means uploading two files; there is no
 * service to run and nothing to trust beyond the digests in the document.
 */
export const CASE_MARKETPLACE_INDEX_URL =
  'https://github.com/naiyixi/PureScience/releases/download/case-index/case-marketplace.json'

export type CaseMarketplaceEntry = {
  /** Stable identity: re-publishing a case keeps its id so an installed copy can be recognised. */
  id: string
  name: string
  domain: string
  summary: string
  author: string
  /** Must be an OSI-approved short name or "proprietary" — the reader warns on anything else. */
  license: string
  bundleUrl: string
  bundleSha256: string
  fileCount: number
  totalBytes: number
  publishedAt: number
  /** Older app versions must not silently install a case whose bundle format they do not understand. */
  minAppVersion?: string
}

export type CaseMarketplaceIndex = {
  format: typeof CASE_MARKETPLACE_FORMAT
  version: number
  updatedAt: number
  cases: ReadonlyArray<CaseMarketplaceEntry>
}

export type CaseMarketplaceProblem =
  | 'unknown-format'
  | 'unsupported-version'
  | 'bad-index'
  | 'no-cases'
  | 'too-many-cases'
  | 'duplicate-id'
  | 'bad-case-entry'
  | 'bad-url'
  | 'bad-sha256'

export type CaseMarketplaceResult =
  | { ok: true; index: CaseMarketplaceIndex }
  | { ok: false; problem: CaseMarketplaceProblem; detail?: string }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const asTrimmed = (value: unknown): string | null => {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length === 0 ? null : trimmed
}

const asCount = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null

const SHA256 = /^[0-9a-f]{64}$/

// A marketplace entry is a *link to bytes*, so the link itself is part of the trust surface: plain https only, no
// credentials in the URL, and no scheme we would have to carry a handler for.
const checkUrl = (url: string): boolean => {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && parsed.username === '' && parsed.password === ''
  } catch {
    return false
  }
}

export const validateCaseMarketplaceIndex = (value: unknown): CaseMarketplaceResult => {
  if (!isRecord(value)) return { ok: false, problem: 'bad-index' }
  if (value.format !== CASE_MARKETPLACE_FORMAT) return { ok: false, problem: 'unknown-format' }
  if (value.version !== CASE_MARKETPLACE_VERSION) {
    return {
      ok: false,
      problem: 'unsupported-version',
      detail: String(value.version ?? 'missing')
    }
  }
  if (!Array.isArray(value.cases)) return { ok: false, problem: 'bad-index', detail: 'cases' }
  if (value.cases.length === 0) return { ok: false, problem: 'no-cases' }
  if (value.cases.length > CASE_MARKETPLACE_CASE_LIMIT) {
    return {
      ok: false,
      problem: 'too-many-cases',
      detail: String(value.cases.length)
    }
  }

  const seen = new Set<string>()
  const cases: CaseMarketplaceEntry[] = []
  for (const [position, raw] of value.cases.entries()) {
    if (!isRecord(raw)) return { ok: false, problem: 'bad-case-entry', detail: `#${position}` }
    const id = asTrimmed(raw.id)
    const name = asTrimmed(raw.name)
    const domain = asTrimmed(raw.domain)
    const summary = asTrimmed(raw.summary)
    const author = asTrimmed(raw.author)
    const license = asTrimmed(raw.license)
    const bundleUrl = asTrimmed(raw.bundleUrl)
    const bundleSha256 = asTrimmed(raw.bundleSha256)?.toLowerCase() ?? null
    const fileCount = asCount(raw.fileCount)
    const totalBytes = asCount(raw.totalBytes)
    const publishedAt = asCount(raw.publishedAt)
    if (
      id === null ||
      name === null ||
      domain === null ||
      summary === null ||
      author === null ||
      license === null ||
      bundleUrl === null ||
      bundleSha256 === null ||
      fileCount === null ||
      totalBytes === null ||
      publishedAt === null
    ) {
      return { ok: false, problem: 'bad-case-entry', detail: id ?? `#${position}` }
    }
    if (seen.has(id)) return { ok: false, problem: 'duplicate-id', detail: id }
    seen.add(id)
    if (!checkUrl(bundleUrl)) return { ok: false, problem: 'bad-url', detail: id }
    if (!SHA256.test(bundleSha256)) return { ok: false, problem: 'bad-sha256', detail: id }
    const minAppVersion = asTrimmed(raw.minAppVersion)
    cases.push({
      id,
      name,
      domain,
      summary,
      author,
      license,
      bundleUrl,
      bundleSha256,
      fileCount,
      totalBytes,
      publishedAt,
      ...(minAppVersion === null ? {} : { minAppVersion })
    })
  }

  return {
    ok: true,
    index: {
      format: CASE_MARKETPLACE_FORMAT,
      version: CASE_MARKETPLACE_VERSION,
      updatedAt: asCount(value.updatedAt) ?? 0,
      cases
    }
  }
}

// Search covers exactly what a reader can see on the card: the case name, its domain, and who published it.
export const searchMarketplaceCases = (
  index: CaseMarketplaceIndex,
  query: string
): ReadonlyArray<CaseMarketplaceEntry> => {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return index.cases
  return index.cases.filter((entry) =>
    `${entry.name}\n${entry.domain}\n${entry.author}`.toLowerCase().includes(needle)
  )
}
