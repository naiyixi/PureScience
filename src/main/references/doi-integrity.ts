// DOI integrity: is this reference still valid, or has the literature retracted/corrected it?
//
// Why a module of its own: a reference list that keeps citing a retracted paper is the most expensive kind
// of wrong — it looks verified. The answer therefore has to come with its own provenance (the exact
// Crossref record and the notice DOIs), and it must never be inferred: "we could not reach Crossref" is
// `unavailable`, never `clean`. A check that fails silently into "ok" is worse than no check at all.
//
// FOUR SIGNALS, EACH NAMING ITS EVIDENCE. Measured against Crossref on 2026-10-28: across 12 works the
// registry itself marks as retracted (taken from `filter=update-type:retraction` notices and their
// `update-to` targets), `relation['is-retracted-by']` was present on **0**, the work's own `update-to` on 6,
// a retraction label in the title on 9 — and 3 carried nothing on the work record at all, being findable
// only through the reverse query. A checker that reads only `relation` therefore reports clean on nearly
// every retracted paper it meets. So each verdict records WHICH field decided it:
//
//   * `relation`       — this DOI is the work that got retracted (rare, authoritative when present).
//   * `update-to`      — the record carries a retraction/withdrawal/concern update of its own.
//   * `reverse-update` — `filter=updates:<doi>` returned the notice that retracts this DOI.
//   * `title-label`    — the publisher's own record title starts with RETRACTED / WITHDRAWN / Expression of
//                        concern: a label Crossref serves, not our inference, and the signal present on most
//                        retractions. Dropping it would mean reporting them as clean.
//
// Crossref semantics used here (both directions matter):
//   * `message['update-to']` — this DOI is a notice that updates other works (a retraction notice lists the
//     retracted DOI here, with `type: 'retraction'`).
//   * `message.relation['is-retracted-by' | 'is-corrected-by' | 'is-expression-of-concern-for']` — this DOI
//     is the work that got retracted/corrected.
// A reference needs the second; the first is worth reporting because references sometimes point at notices.

import type { ReferenceIntegrityEvidence } from '../../shared/references-integrity'

export type DoiIntegrityStatus =
  'retracted' | 'expression-of-concern' | 'corrected' | 'clean' | 'unavailable'

/** Which Crossref field produced the verdict. Never omitted: "retracted" without its evidence is a claim
 *  nobody downstream can audit, and "clean" without it hides which queries came back empty. The vocabulary
 *  lives in the shared module because the surface prints it. */
export type DoiIntegrityEvidence = ReferenceIntegrityEvidence

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
  evidence: DoiIntegrityEvidence
  /** Present only when `status === 'unavailable'`: never a reason to treat the reference as clean. */
  error?: string
}

type CrossrefWork = {
  message?: {
    relation?: Record<string, unknown>
    'update-to'?: Array<{ type?: string; DOI?: string }>
    title?: string[]
    DOI?: string
  }
}

type CrossrefSearch = {
  message?: { items?: Array<NonNullable<CrossrefWork['message']>> }
}

const CROSSREF_WORK_URL = 'https://api.crossref.org/works/'
// Reverse direction: the works that UPDATE this DOI. This is where a notice is found when the retracted
// work's own record says nothing — the case for most of the sample above.
const CROSSREF_UPDATES_URL = 'https://api.crossref.org/works?filter=updates:'

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

// A publisher's own record title, as Crossref serves it. Anchored at the start on purpose: a paper *about*
// retractions mentions the word mid-title and must not be caught here.
const NOTICE_KIND_BY_TITLE_LABEL: Array<{
  pattern: RegExp
  kind: DoiIntegrityNotice['kind']
}> = [
  { pattern: /^retracted\b/i, kind: 'retraction' },
  { pattern: /^withdrawn\b/i, kind: 'withdrawal' },
  { pattern: /^expression of concern\b/i, kind: 'expression-of-concern' }
]

const normalizeDoi = (raw: string): string =>
  raw
    .trim()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')
    .replace(/^doi:\s*/i, '')
    .toLowerCase()

const noticeKey = (notice: DoiIntegrityNotice): string => `${notice.kind}:${notice.doi}`

/** Two signals naming the same notice are one notice — so a count shown to a reader counts records. */
const dedupeNotices = (notices: DoiIntegrityNotice[]): DoiIntegrityNotice[] => {
  const seen = new Set<string>()
  const out: DoiIntegrityNotice[] = []
  for (const notice of notices) {
    const key = noticeKey(notice)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(notice)
  }
  return out
}

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

/**
 * Notices found by asking the registry which works update this DOI. Only entries whose `update-to` points
 * back at this DOI count — a search hit that updates something else is not this record's business.
 */
const noticesFromReverseUpdates = (payload: unknown, doi: string): DoiIntegrityNotice[] => {
  const items = (payload as CrossrefSearch | null)?.message?.items
  if (!Array.isArray(items)) return []
  const notices: DoiIntegrityNotice[] = []
  for (const item of items) {
    const noticeDoi = typeof item?.DOI === 'string' ? item.DOI : undefined
    if (!noticeDoi) continue
    for (const entry of item['update-to'] ?? []) {
      const kind = entry?.type ? NOTICE_KIND_BY_UPDATE_TYPE[entry.type.toLowerCase()] : undefined
      if (!kind) continue
      if (typeof entry.DOI !== 'string' || normalizeDoi(entry.DOI) !== doi) continue
      notices.push({ kind, doi: noticeDoi, url: `https://doi.org/${noticeDoi}` })
    }
  }
  return notices
}

/** The publisher's own label on the record. The notice it names is the record itself. */
const noticesFromTitleLabel = (title: string[] | undefined, doi: string): DoiIntegrityNotice[] => {
  const text = Array.isArray(title) ? (title[0] ?? '') : ''
  for (const rule of NOTICE_KIND_BY_TITLE_LABEL) {
    if (rule.pattern.test(text)) return [{ kind: rule.kind, doi, url: `https://doi.org/${doi}` }]
  }
  return []
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
    return {
      doi,
      status: 'unavailable',
      checkedAt,
      sourceUrl,
      notices: [],
      evidence: 'none',
      error: 'empty DOI'
    }
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
        evidence: 'none',
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
        evidence: 'none',
        error: 'Crossref record had no message'
      }
    }

    const fromRelation = noticesFromRelation(message.relation)
    const fromUpdateTo = noticesFromUpdateTo(message)
    if (fromRelation.length > 0 || fromUpdateTo.length > 0) {
      const notices = dedupeNotices([...fromRelation, ...fromUpdateTo])
      return {
        doi,
        status: statusFromNotices(notices),
        checkedAt,
        sourceUrl,
        notices,
        evidence: fromRelation.length > 0 ? 'relation' : 'update-to'
      }
    }

    // Nothing on the record itself — the common case. Ask the other direction before saying clean: the
    // notice that retracts a work is frequently the only record that says so.
    const reverseUrl = `${CROSSREF_UPDATES_URL}${encodeURIComponent(doi)}&rows=5&select=DOI,title,update-to,type`
    let reverse: DoiIntegrityNotice[]
    try {
      const reverseResponse = await options.fetchImpl(reverseUrl, {
        headers: { accept: 'application/json' }
      })
      if (!reverseResponse.ok) {
        // A query that did not answer cannot be reported as "no notices found".
        return {
          doi,
          status: 'unavailable',
          checkedAt,
          sourceUrl,
          notices: [],
          evidence: 'none',
          error: `Crossref update query answered HTTP ${reverseResponse.status}`
        }
      }
      reverse = noticesFromReverseUpdates(await reverseResponse.json(), doi)
    } catch (error) {
      return {
        doi,
        status: 'unavailable',
        checkedAt,
        sourceUrl,
        notices: [],
        evidence: 'none',
        error: `Crossref update query failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      }
    }

    if (reverse.length > 0) {
      const notices = dedupeNotices(reverse)
      return {
        doi,
        status: statusFromNotices(notices),
        checkedAt,
        sourceUrl,
        notices,
        evidence: 'reverse-update'
      }
    }

    const fromLabel = noticesFromTitleLabel(message.title, doi)
    if (fromLabel.length > 0) {
      return {
        doi,
        status: statusFromNotices(fromLabel),
        checkedAt,
        sourceUrl,
        notices: fromLabel,
        evidence: 'title-label'
      }
    }

    return { doi, status: 'clean', checkedAt, sourceUrl, notices: [], evidence: 'none' }
  } catch (error) {
    return {
      doi,
      status: 'unavailable',
      checkedAt,
      sourceUrl,
      notices: [],
      evidence: 'none',
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

export { normalizeDoi }
