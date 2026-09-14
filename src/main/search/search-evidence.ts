import { createHash } from 'node:crypto'

import {
  SEARCH_EVIDENCE_HASH_RECIPE,
  SEARCH_EVIDENCE_SCHEMA_VERSION,
  searchEvidenceSnippet,
  type SearchEvidenceCaptureResult,
  type SearchEvidenceLine,
  type SearchEvidenceReason,
  type SearchEvidenceRequest,
  type SearchEvidenceResponse,
  type SearchEvidenceVerificationResult
} from '../../shared/search-evidence'
import type { SearchableSessionMessage } from './global-search-service'

// Captures and rechecks a search hit as evidence.
//
// The fingerprint is computed here, from the block as the session actually stores it, and the recipe is
// published in the shared contract — so a third party holding the block text can recompute it. A block
// whose stored text was truncated cannot be fingerprinted faithfully, and that is refused by name rather
// than papered over with a hash of the truncation.

export type SearchEvidencePorts = {
  readSessionMessages(sessionId: string): Promise<SearchableSessionMessage[]>
}

export type SearchEvidenceService = {
  capture(
    request: Extract<SearchEvidenceRequest, { action: 'capture' }>
  ): Promise<SearchEvidenceCaptureResult>
  verify(line: SearchEvidenceLine): Promise<SearchEvidenceVerificationResult>
  handle(request: SearchEvidenceRequest): Promise<SearchEvidenceResponse>
}

const fingerprintFor = (input: { sessionId: string; messageId: string; text: string }): string => {
  const digest = createHash('sha256')
    .update(`${SEARCH_EVIDENCE_HASH_RECIPE}\n`)
    .update(`${input.sessionId}\n`)
    .update(`${input.messageId}\n`)
    .update(input.text)
    .digest('hex')

  return `sha256:${digest}`
}

const unavailable = (
  reason: SearchEvidenceReason
): { status: 'unavailable'; reason: SearchEvidenceReason } => ({
  status: 'unavailable',
  reason
})

const findMessage = async (
  ports: SearchEvidencePorts,
  sessionId: string,
  messageId: string
): Promise<
  | { status: 'found'; message: SearchableSessionMessage }
  | { status: 'unavailable'; reason: SearchEvidenceReason }
> => {
  let messages: SearchableSessionMessage[]
  try {
    messages = await ports.readSessionMessages(sessionId)
  } catch {
    return unavailable('session-unavailable')
  }

  const message = messages.find((candidate) => candidate.id === messageId)
  if (!message) return unavailable('message-not-found')
  // A truncated body is not the block: refuse rather than fingerprint a prefix that will never verify.
  if (message.truncated) return unavailable('text-truncated')

  return { status: 'found', message }
}

export const createSearchEvidenceService = (ports: SearchEvidencePorts): SearchEvidenceService => {
  const capture = async (
    request: Extract<SearchEvidenceRequest, { action: 'capture' }>
  ): Promise<SearchEvidenceCaptureResult> => {
    const found = await findMessage(ports, request.sessionId, request.messageId)
    if (found.status === 'unavailable') return found

    const { message } = found
    const line: SearchEvidenceLine = {
      schemaVersion: SEARCH_EVIDENCE_SCHEMA_VERSION,
      projectId: request.projectId,
      sessionId: request.sessionId,
      messageId: request.messageId,
      role: message.role,
      capturedAt: request.capturedAt ?? new Date().toISOString(),
      query: request.query,
      terms: request.terms ?? [],
      snippet: request.snippet ?? searchEvidenceSnippet(message.text),
      fingerprint: fingerprintFor({
        sessionId: request.sessionId,
        messageId: request.messageId,
        text: message.text
      })
    }

    return { status: 'captured', line }
  }

  const verify = async (line: SearchEvidenceLine): Promise<SearchEvidenceVerificationResult> => {
    const found = await findMessage(ports, line.sessionId, line.messageId)
    if (found.status === 'unavailable') return found

    const fingerprintNow = fingerprintFor({
      sessionId: line.sessionId,
      messageId: line.messageId,
      text: found.message.text
    })

    if (fingerprintNow !== line.fingerprint) {
      return { ...unavailable('fingerprint-mismatch'), fingerprintNow }
    }

    return { status: 'verified', fingerprint: fingerprintNow }
  }

  return {
    capture,
    verify,
    handle: async (request) =>
      request.action === 'capture' ? capture(request) : verify(request.line)
  }
}
