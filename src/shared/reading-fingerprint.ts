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
// 4. There is deliberately NO in-app verifier. One was written (four verdicts: verified /
//    not-recorded / malformed / mismatch) and then withdrawn, because nothing called it: the promise
//    this module makes is that anyone — inside the app or not — can recompute the digest from the
//    published recipe, and the surface renders the recipe and the digest for exactly that. Shipping a
//    checker nobody invokes would be the same mistake as a field nobody reads.
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
 * The key a connector result carries its readings under.
 *
 * Snake_case, like every other connector result field, because the agent reads these.
 */
/**
 * A reading as RECORDED for a session: the fingerprint plus the run it was taken in, when the notebook
 * runtime could name one. The engine never sets `runId` — it is added by the journal, from the main
 * process's own session state.
 */
export type RecordedConnectorReading = ConnectorReadingFingerprint & { runId?: string }

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
