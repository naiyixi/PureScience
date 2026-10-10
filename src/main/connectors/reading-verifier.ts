import { createHash } from 'node:crypto'

import {
  READING_FINGERPRINT_PREFIX,
  readingDigestInput,
  type ConnectorReadingFingerprint,
  type ReadingVerification
} from '../../shared/reading-fingerprint'
import { USER_AGENT } from './engine'

const DEFAULT_TIMEOUT_MS = 30_000

export type ReadingVerifierDeps = {
  /**
   * Whether this process can re-issue a request for that service at all. Injected rather than reached
   * for, so the refusal is a named answer about a registry rather than a guess about the network.
   */
  hasService: (service: string) => boolean
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

/**
 * Re-issue a recorded reading and report what came back.
 *
 * This is the only thing that can turn a recorded digest into a checked one: the digest is computed
 * over the response BYTES, and the bytes are deliberately not stored — so nothing short of asking the
 * source again can compare anything. Everything that would make that comparison a lie is refused by
 * name first, and a refusal never carries a comparison that did not happen:
 *
 * - a request that was not a GET is not replayed (replaying it could repeat a write);
 * - a URL whose credential parameters were stripped is not re-issued (it is not the request that was
 *   sent, so the answer would be about a different request);
 * - a record without the fields a faithful re-issue needs is refused as `not-recorded` rather than
 *   re-issued approximately — an approximate re-issue reported as a mismatch would blame the source.
 *
 * A `mismatch` is a real answer, not a failure: the same URL, asked again, produced different bytes.
 * Its cause is left to the two digests and the status the caller is given, not to a story told here.
 */
export const verifyRecordedReading = async (
  reading: ConnectorReadingFingerprint,
  deps: ReadingVerifierDeps
): Promise<ReadingVerification> => {
  if (reading.request.method !== 'GET') return { state: 'unavailable', reason: 'not-a-read' }
  if (!deps.hasService(reading.service)) {
    return { state: 'unavailable', reason: 'service-unknown' }
  }
  const accept = reading.request.accept
  const stripped = reading.request.credentials_stripped
  if (!Array.isArray(stripped) || typeof accept !== 'string') {
    return { state: 'unavailable', reason: 'not-recorded' }
  }
  if (stripped.length > 0) return { state: 'unavailable', reason: 'credentials-stripped' }

  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const fetchImpl = deps.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchImpl(reading.request.url, {
      headers: { accept, 'user-agent': USER_AGENT },
      signal: controller.signal
    })
    // No byte view means nothing to hash — the same rule the recorder follows. Reported as a failed
    // re-issue, never as a match: an unobserved body must not be recorded as a pass.
    if (typeof (res as { arrayBuffer?: unknown }).arrayBuffer !== 'function') {
      return { state: 'unavailable', reason: 'request-failed' }
    }
    const bytes = new Uint8Array(await res.arrayBuffer())
    const digest = createHash('sha256')
      .update(readingDigestInput('GET', reading.request.url, res.status))
      .update(bytes)
      .digest('hex')
    const recomputed = `${READING_FINGERPRINT_PREFIX}${digest}`
    return recomputed === reading.response.sha256
      ? { state: 'matched', recorded: reading.response.sha256, recomputed, status: res.status }
      : { state: 'mismatch', recorded: reading.response.sha256, recomputed, status: res.status }
  } catch {
    return { state: 'unavailable', reason: 'request-failed' }
  } finally {
    clearTimeout(timer)
  }
}
