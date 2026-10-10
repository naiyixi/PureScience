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

/**
 * The exact string a fingerprint's digest is computed over, before the response bytes are appended.
 *
 * Shared so that the recorder and anyone re-issuing the request compose it identically, and so a reader
 * can see the composition here instead of inferring it from a behaviour.
 */
export const readingDigestInput = (method: 'GET' | 'POST', url: string, status: number): string =>
  `${READING_FINGERPRINT_HASH_RECIPE}\n${method}\n${url}\n${status}\n`

/**
 * Why a recorded reading could not be re-issued here. Machine-readable names, never prose: a surface
 * renders the name it received rather than a sentence invented at the call site.
 *
 * - `not-recorded` — the record predates the fields a faithful re-issue needs (accept / stripped list)
 * - `credentials-stripped` — credential parameters were removed before the URL was recorded, so the
 *   recorded URL is NOT the request that was sent and re-issuing it would fetch something else
 * - `not-a-read` — the recorded request was not a GET, so replaying it could repeat a write
 * - `service-unknown` — no connector by that name, so nothing here can re-issue it
 * - `request-failed` — the re-issue did not produce bytes to compare (transport failure, or a transport
 *   with no byte view)
 */
export type ReadingVerificationRefusal =
  'not-recorded' | 'credentials-stripped' | 'not-a-read' | 'service-unknown' | 'request-failed'

/**
 * What re-issuing a recorded reading produced. `matched`/`mismatch` carry BOTH digests and the status
 * the re-issue returned, so a surface can show what was compared and a reader can see a changed status
 * rather than having to guess why the digests differ. `unavailable` carries a name and never a
 * comparison that did not happen.
 */
export type ReadingVerification =
  | { state: 'matched'; recorded: string; recomputed: string; status: number }
  | { state: 'mismatch'; recorded: string; recomputed: string; status: number }
  | { state: 'unavailable'; reason: ReadingVerificationRefusal }

/**
 * What the renderer asks to have re-issued: a session and the digest of a reading it is looking at.
 *
 * Deliberately no URL: if the renderer could name one, this channel would be an outbound fetcher for
 * whatever the renderer liked, wearing the app's user-agent. Instead the main process looks the digest
 * up among the readings IT recorded for that session, and re-issues what it finds — so the capability
 * is exactly "re-verify a reading this app took", and nothing wider.
 */
export type VerifyReadingRequest = {
  /** The session whose journal holds the reading. */
  appSessionId: string
  /** `response.sha256` of the reading to re-issue. */
  digest: string
}

export type ConnectorReadingFingerprint = {
  /** The connector the reading came from, e.g. `pubmed`. */
  service: string
  /** The tool that was called, e.g. `search_articles`. */
  tool: string
  request: {
    method: 'GET' | 'POST'
    /** The request URL with credentials redacted, exactly as the engine logged it. */
    url: string
    /**
     * The NAMES of the query parameters removed before this URL was recorded — never their values.
     * Recorded (possibly as an empty list, meaning nothing was removed) because a stripped URL is no
     * longer the request that was sent: a verifier that re-issued it would fetch something else, so it
     * has to be able to say so instead. Absent means the record predates this field, and nothing can be
     * concluded about stripping.
     */
    credentials_stripped?: string[]
    /**
     * The Accept header the request was sent with, so a re-issue can be the same request: a different
     * Accept can return a different body, which would surface as a mismatch that is not the source's
     * doing. Absent means the record predates this field.
     */
    accept?: string
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
