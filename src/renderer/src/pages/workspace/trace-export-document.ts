// Turns a loaded session plus its reviews into the execution-trace document, using only what the app
// already recorded: the session's activities become the steps, the reviewer's checks become the model
// findings, and the pins become the human evidence — three separate things, deliberately not merged.

import type { ConversationExportTrace } from '../../../../shared/conversation-export'
import { buildTraceExportDocument, type TraceExportActivity } from '../../../../shared/trace-export'
import type { ReviewEvidenceAttachment } from '../../../../shared/review-evidence'
import type { ReviewWithChecks } from '../../../../shared/reviewer'
import type { ChatSession } from '@/stores/session-store'

const activityOf = (session: ChatSession): TraceExportActivity[] =>
  (session.activities ?? []).map((activity) => ({
    title: activity.title,
    status: activity.status,
    sortIndex: activity.sortIndex,
    ...(activity.providerToolName ? { providerToolName: activity.providerToolName } : {}),
    ...(activity.toolLocations ? { toolLocations: activity.toolLocations } : {}),
    ...(typeof activity.terminalExitCode === 'number'
      ? { terminalExitCode: activity.terminalExitCode }
      : {})
  }))

export const buildTraceExportFromSession = ({
  session,
  reviews,
  pins,
  generatedAt
}: {
  session: ChatSession
  reviews: readonly ReviewWithChecks[]
  pins: readonly ReviewEvidenceAttachment[]
  generatedAt: string
}): ConversationExportTrace =>
  buildTraceExportDocument({
    title: session.title,
    generatedAt,
    project: session.projectId,
    activities: activityOf(session),
    findings: reviews.flatMap((review) =>
      review.checks.map((check) => ({
        claim: check.claim,
        status: check.status,
        ...(check.evidence ? { evidence: check.evidence } : {})
      }))
    ),
    humanEvidence: pins.map((pin) => ({
      snippet: pin.snippet,
      fingerprint: pin.fingerprint,
      role: pin.role,
      ...(pin.query ? { query: pin.query } : {}),
      ...(pin.terms.length > 0 ? { terms: pin.terms } : {}),
      capturedAt: pin.capturedAt
    }))
  })
