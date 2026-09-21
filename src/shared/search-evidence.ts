// A search hit used as evidence.
//
// The competitor's palette stops at "jump to the hit". A hit is only usable as evidence if someone else
// can check it later, so a captured line carries a fingerprint computed from the block as it is stored,
// and the recipe is published here: anyone holding the block can recompute it.
//
// Nothing here touches node:crypto — this module is shared with the renderer, which never hashes.

export const SEARCH_EVIDENCE_SCHEMA_VERSION = 1

// Published so a fingerprint can be recomputed outside the app: sha256 over these lines, in this order,
// each terminated by "\n" (the last one included).
export const SEARCH_EVIDENCE_HASH_RECIPE = 'purescience-search-evidence-v1'

export const SEARCH_EVIDENCE_MAX_SNIPPET = 240

// The saved filter set a capture was made under. Recorded by name AND by what it accepts, because the
// name alone cannot be checked by whoever reads the line later: the set may have been edited since, so
// the line has to carry the filters the results were actually asked for.
export const SEARCH_EVIDENCE_MAX_PIN_NAME_CHARS = 80

export type SearchEvidencePinnedFilters = {
  name: string
  description: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const trimmedText = (value: unknown, limit: number): string | undefined => {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  if (text === '') return undefined
  return text.length <= limit ? text : text.slice(0, limit)
}

/**
 * Reads the optional pinned-filter attribution. A half-present or unreadable value is dropped rather than
 * carried: a line that named a filter set without saying what it accepts would be worse than a line that
 * does not mention one.
 */
export const sanitizeSearchEvidencePinnedFilters = (
  value: unknown
): SearchEvidencePinnedFilters | undefined => {
  if (!isRecord(value)) return undefined
  const name = trimmedText(value.name, SEARCH_EVIDENCE_MAX_PIN_NAME_CHARS)
  const description = trimmedText(value.description, SEARCH_EVIDENCE_MAX_PIN_NAME_CHARS * 4)
  if (!name || !description) return undefined
  return { name, description }
}

// Why a line could not be produced, or no longer holds. Always named — never a bare boolean.
export type SearchEvidenceReason =
  // The block is not in the session as it stands now.
  | 'message-not-found'
  // The session could not be read at all.
  | 'session-unavailable'
  // The stored text exceeded the searchable budget. Hashing it would fingerprint a truncation rather
  // than the block, so no line is offered instead of a fingerprint that cannot hold.
  | 'text-truncated'
  // The block is there but its text is no longer what was captured.
  | 'fingerprint-mismatch'

export type SearchEvidenceLine = {
  schemaVersion: typeof SEARCH_EVIDENCE_SCHEMA_VERSION
  projectId: string
  sessionId: string
  messageId: string
  role: 'user' | 'agent'
  capturedAt: string
  // The query and the terms it was searched as, so the line says how this block was found.
  query: string
  terms: string[]
  snippet: string
  fingerprint: string
  /** The saved filter set the capture was made under, when the user had one applied. */
  pinnedFilters?: SearchEvidencePinnedFilters
}

export type SearchEvidenceCaptureResult =
  | { status: 'captured'; line: SearchEvidenceLine }
  | { status: 'unavailable'; reason: SearchEvidenceReason }

export type SearchEvidenceVerificationResult =
  | { status: 'verified'; fingerprint: string }
  | {
      status: 'unavailable'
      reason: SearchEvidenceReason
      // Present for `fingerprint-mismatch`: what the block hashes to now.
      fingerprintNow?: string
    }

export type SearchEvidenceRequest =
  | {
      action: 'capture'
      projectId: string
      sessionId: string
      messageId: string
      query: string
      terms?: string[]
      snippet?: string
      capturedAt?: string
      pinnedFilters?: SearchEvidencePinnedFilters
    }
  | { action: 'verify'; line: SearchEvidenceLine }

export type SearchEvidenceResponse = SearchEvidenceCaptureResult | SearchEvidenceVerificationResult

export type SearchEvidenceLabels = {
  header: string
  query: string
  terms: string
  snippet: string
  fingerprint: string
  pinned: string
}

// One pasteable block. Labels come from the UI language; the fingerprint and the identifiers do not
// translate, because the point of the line is that someone else can check it.
export const formatSearchEvidenceLine = (
  line: SearchEvidenceLine,
  labels: SearchEvidenceLabels
): string =>
  [
    `${labels.header}: ${line.projectId} / ${line.sessionId} / ${line.messageId} (${line.role}) ${line.capturedAt}`,
    `${labels.query}: ${line.query}`,
    `${labels.terms}: ${line.terms.join(', ')}`,
    `${labels.snippet}: ${line.snippet}`,
    // Only present when a saved filter set was applied, and it carries the filters themselves: the name on
    // its own would not say what the results were asked for.
    ...(line.pinnedFilters
      ? [`${labels.pinned}: ${line.pinnedFilters.name} (${line.pinnedFilters.description})`]
      : []),
    `${labels.fingerprint}: ${line.fingerprint}`
  ].join('\n')

export const searchEvidenceSnippet = (text: string, limit = SEARCH_EVIDENCE_MAX_SNIPPET): string =>
  text.length <= limit ? text : `${text.slice(0, limit)}…`
