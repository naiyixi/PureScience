// DOI integrity: is this reference still valid, or has the literature retracted/corrected it?
//
// Why a module of its own: a reference list that keeps citing a retracted paper is the most expensive kind
// of wrong — it looks verified. The answer therefore has to come with its own provenance (the exact
// Crossref record and the notice DOIs), and it must never be inferred: "we could not reach Crossref" is
// `unavailable`, never `clean`. A check that fails silently into "ok" is worse than no check at all.
//
// Crossref semantics used here (both directions matter):
//   * `message['update-to']` — this DOI is a notice that updates other works (a retraction notice lists the
//     retracted DOI here, with `type: 'retraction'`).
//   * `message.relation['is-retracted-by' | 'is-corrected-by' | 'is-expression-of-concern-for']` — this DOI
//     is the work that got retracted/corrected.
// A reference needs the second; the first is worth reporting because references sometimes point at notices.

export type DoiIntegrityStatus =
  'retracted' | 'expression-of-concern' | 'corrected' | 'clean' | 'unavailable'

export type DoiIntegrityNotice = {
  kind: 'retraction' | 'correction' | 'expression-of-concern' | 'withdrawal'
  /** The notice's own DOI — the thing a reader clicks to judge the claim. */
  doi: string
  url: string
}

export type DoiIntegrityCheck = {
  doi: string
  status: DoiIntegrityStatus
  /** ISO timestamp of the check; a stored result without one cannot be audited. */
  checkedAt: string
  /** The exact record this verdict came from. */
  sourceUrl: string
  notices: DoiIntegrityNotice[]
  /** Present only when `status === 'unavailable'`: never a reason to treat the reference as clean. */
  error?: string
}

type CrossrefWork = {
  message?: {
    relation?: Record<string, unknown>
    'update-to'?: Array<{ type?: string; DOI?: string }>
    DOI?: string
  }
}

const CROSSREF_WORK_URL = 'https://api.crossref.org/works/'

const NOTICE_KIND_BY_RELATION: Record<
  string,
  'retraction' | 'correction' | 'expression-of-concern'
> = {
  'is-retracted-by': 'retraction',
  'is-corrected-by': 'correction',
  'is-expression-of-concern-for': 'expression-of-concern'
}

const NOTICE_KIND_BY_UPDATE_TYPE: Record<
  string,
  'retraction' | 'correction' | 'expression-of-concern' | 'withdrawal'
> = {
  retraction: 'retraction',
  correction: 'correction',
  erratum: 'correction',
  'expression-of-concern': 'expression-of-concern',
  withdrawal: 'withdrawal'
}

const normalizeDoi = (raw: string): string =>
  raw
    .trim()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')
    .replace(/^doi:\s*/i, '')
    .toLowerCase()

const noticesFromRelation = (
  relation: Record<string, unknown> | undefined
): DoiIntegrityNotice[] => {
  if (!relation) return []
  const notices: DoiIntegrityNotice[] = []
  for (const [key, value] of Object.entries(relation)) {
    const kind = NOTICE_KIND_BY_RELATION[key]
    if (!kind || !Array.isArray(value)) continue
    for (const entry of value) {
      const doi =
        typeof entry === 'object' && entry !== null ? (entry as { id?: unknown }).id : null
      if (typeof doi !== 'string' || doi.length === 0) continue
      notices.push({ kind, doi, url: `https://doi.org/${doi}` })
    }
  }
  return notices
}

const noticesFromUpdateTo = (updateTo: CrossrefWork['message']): DoiIntegrityNotice[] => {
  if (!Array.isArray(updateTo?.['update-to'])) return []
  const notices: DoiIntegrityNotice[] = []
  for (const entry of updateTo['update-to']) {
    const kind = entry?.type ? NOTICE_KIND_BY_UPDATE_TYPE[entry.type.toLowerCase()] : undefined
    if (!kind || typeof entry.DOI !== 'string' || entry.DOI.length === 0) continue
    notices.push({ kind, doi: entry.DOI, url: `https://doi.org/${entry.DOI}` })
  }
  return notices
}

// Severity order: a retracted paper that also has a correction is retracted.
const statusFromNotices = (notices: DoiIntegrityNotice[]): DoiIntegrityStatus => {
  if (notices.some((notice) => notice.kind === 'retraction' || notice.kind === 'withdrawal')) {
    return 'retracted'
  }
  if (notices.some((notice) => notice.kind === 'expression-of-concern')) {
    return 'expression-of-concern'
  }
  if (notices.some((notice) => notice.kind === 'correction')) return 'corrected'
  return 'clean'
}

export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string> }
) => Promise<{
  ok: boolean
  status: number
  json: () => Promise<unknown>
}>

export const checkDoiIntegrity = async (
  rawDoi: string,
  options: { fetchImpl: FetchLike; now?: () => Date }
): Promise<DoiIntegrityCheck> => {
  const doi = normalizeDoi(rawDoi)
  const checkedAt = (options.now?.() ?? new Date()).toISOString()
  const sourceUrl = `${CROSSREF_WORK_URL}${encodeURIComponent(doi)}`

  if (doi.length === 0) {
    return { doi, status: 'unavailable', checkedAt, sourceUrl, notices: [], error: 'empty DOI' }
  }

  try {
    const response = await options.fetchImpl(sourceUrl, {
      headers: { accept: 'application/json' }
    })
    if (!response.ok) {
      return {
        doi,
        status: 'unavailable',
        checkedAt,
        sourceUrl,
        notices: [],
        error: `Crossref answered HTTP ${response.status}`
      }
    }

    const payload = (await response.json()) as CrossrefWork
    const message = payload.message
    // A record with no `message` is not "clean": it is unreadable input.
    if (!message) {
      return {
        doi,
        status: 'unavailable',
        checkedAt,
        sourceUrl,
        notices: [],
        error: 'Crossref record had no message'
      }
    }

    const notices = [...noticesFromRelation(message.relation), ...noticesFromUpdateTo(message)]
    return { doi, status: statusFromNotices(notices), checkedAt, sourceUrl, notices }
  } catch (error) {
    return {
      doi,
      status: 'unavailable',
      checkedAt,
      sourceUrl,
      notices: [],
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

export { normalizeDoi }
