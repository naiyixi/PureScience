// A connector reading, carried with a fingerprint of the bytes it came from.
//
// The evidence surface already does this for a captured search hit (see `search-evidence.ts`): the line
// carries a fingerprint, and the recipe is published so anyone holding the block can recompute it. This
// module is the same frame for the other half of the app's inputs — what a connector actually read from
// an external service. Without it a number in a report is only as good as the reader's memory of the
// call that produced it: the URL is gone, the response is not kept, and there is nothing to check.
//
// Four rules, each with a consumer:
//
// 1. A reading names its service, its tool, the request that was sent and the response that came back —
//    including a digest of the response BYTES, so "this is what the service said" is checkable later.
// 2. The recipe is a published constant, and the digest is computed over it first. A verifier who has
//    the bytes recomputes the same string without this module, which is the only kind of fingerprint
//    worth recording.
// 3. "No fingerprint was recorded" is a NAMED gap (`not-recorded`), never an empty string, a zero or an
//    `unknown` that a reader could mistake for a check that ran and passed.
// 4. The verifier returns a verdict, not a boolean: `verified` carries the fingerprint that matched,
//    `unavailable` names why it could not be checked and, on a mismatch, what the bytes hash to NOW.
//
// Nothing here touches node:crypto — this module is shared with the renderer, which never hashes. The
// digest is computed in the main process; the shared layer owns the recipe, the shape and the verdict.

export const READING_FINGERPRINT_SCHEMA_VERSION = 1

// Published so a fingerprint can be recomputed outside the app: sha256 over the recipe line first, then
// the request method, the (redacted) request URL and the HTTP status — each terminated by "\n" — and
// finally the response body bytes exactly as they were received. The digest is written as
// `sha256:<64 hex>`.
export const READING_FINGERPRINT_HASH_RECIPE = 'purescience-connector-reading-v1'

/** The prefix every fingerprint carries, so a bare hex digest cannot be mistaken for one of ours. */
export const READING_FINGERPRINT_PREFIX = 'sha256:'

export const READING_FINGERPRINT_PATTERN = /^sha256:[a-f0-9]{64}$/

/**
 * Why a reading carries no fingerprint, or cannot be checked. Named on purpose: `not-recorded` says the
 * app never took one (an older session, a call that never left the process), which is a different
 * statement from `fingerprint-mismatch` — the bytes are there and they are not what was recorded.
 */
export const READING_FINGERPRINT_GAPS = [
  // No fingerprint was recorded for this reading. Reported, never treated as a match.
  'not-recorded',
  // A fingerprint is present but is not a well-formed digest, so nothing can be checked against it.
  'malformed-fingerprint',
  // The bytes on hand hash to something else than the recorded fingerprint.
  'fingerprint-mismatch'
] as const

export type ReadingFingerprintGap = (typeof READING_FINGERPRINT_GAPS)[number]

export type ConnectorReadingFingerprint = {
  /** The connector the reading came from, e.g. `pubmed`. */
  service: string
  /** The tool that was called, e.g. `search_articles`. */
  tool: string
  request: {
    method: 'GET' | 'POST'
    /** The request URL with credentials redacted, exactly as the engine logged it. */
    url: string
  }
  response: {
    status: number
    /** Length of the response body in bytes. Carried so a truncated copy is visible without hashing. */
    bytes: number
    sha256: string
  }
}

export type ReadingFingerprintVerdict =
  | { status: 'verified'; fingerprint: string }
  | {
      status: 'unavailable'
      reason: ReadingFingerprintGap
      /**
       * Present for `fingerprint-mismatch`: what the bytes hash to now. So the reader can see that the
       * bytes changed rather than that the check was skipped.
       */
      fingerprintNow?: string
    }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const isReadingFingerprint = (value: unknown): value is ConnectorReadingFingerprint => {
  if (!isRecord(value)) return false
  const request = value.request
  const response = value.response
  if (!isRecord(request) || !isRecord(response)) return false
  return (
    typeof value.service === 'string' &&
    value.service !== '' &&
    typeof value.tool === 'string' &&
    value.tool !== '' &&
    (request.method === 'GET' || request.method === 'POST') &&
    typeof request.url === 'string' &&
    typeof response.status === 'number' &&
    typeof response.bytes === 'number' &&
    typeof response.sha256 === 'string' &&
    READING_FINGERPRINT_PATTERN.test(response.sha256)
  )
}

/**
 * Check a recorded reading against the bytes someone else has.
 *
 * `recomputed` is what the caller worked out with the published recipe — this function never hashes, so
 * it can be shared with the renderer, which is exactly the point: it can only confirm a value the caller
 * derived, never invent one.
 */
export const verifyConnectorReadingFingerprint = (
  recorded: ConnectorReadingFingerprint | undefined,
  recomputed: string | undefined
): ReadingFingerprintVerdict => {
  if (!recorded) return { status: 'unavailable', reason: 'not-recorded' }
  const expected = recorded.response.sha256
  if (!READING_FINGERPRINT_PATTERN.test(expected)) {
    return { status: 'unavailable', reason: 'malformed-fingerprint' }
  }
  if (typeof recomputed !== 'string' || !READING_FINGERPRINT_PATTERN.test(recomputed)) {
    // No recomputation was supplied: nothing was compared, so nothing is verified.
    return { status: 'unavailable', reason: 'not-recorded' }
  }
  if (recomputed !== expected) {
    return { status: 'unavailable', reason: 'fingerprint-mismatch', fingerprintNow: recomputed }
  }
  return { status: 'verified', fingerprint: expected }
}

/**
 * The key a connector result carries its readings under.
 *
 * Snake_case, like every other connector result field, because the agent reads these.
 */
export const CONNECTOR_READING_RESULT_KEY = 'reading_fingerprints'

/**
 * Attach readings to what a connector tool returned.
 *
 * Deliberately limited: a result that is not a plain object is returned UNCHANGED. A tool that returns a
 * list, a string or a number has nowhere to carry provenance, and wrapping it in an envelope here would
 * change the shape every existing consumer reads — the honest move is to leave the value alone rather
 * than have the fingerprint arrive somewhere nobody looks.
 *
 * An empty reading list also returns the value unchanged: a call that never left the process (a local
 * handler) has no reading to fingerprint, and adding an empty list would look like a check that ran.
 */
export const attachReadingFingerprints = <T>(
  value: T,
  readings: readonly ConnectorReadingFingerprint[]
): T => {
  if (!isRecord(value)) return value
  if (readings.length === 0) return value
  return { ...value, [CONNECTOR_READING_RESULT_KEY]: readings } as T
}

/** The readings a connector result carries, or an empty list. Never throws on a foreign shape. */
export const readingsFromConnectorResult = (
  value: unknown
): readonly ConnectorReadingFingerprint[] => {
  if (!isRecord(value)) return []
  const raw = value[CONNECTOR_READING_RESULT_KEY]
  if (!Array.isArray(raw)) return []
  return raw.filter(isReadingFingerprint)
}
