import { describe, expect, it } from 'vitest'

import { buildTraceExportFromSession } from './trace-export-document'
import type { ChatSession } from '@/stores/session-store'
import type { ReviewEvidenceAttachment } from '../../../../shared/review-evidence'
import type { ReviewWithChecks } from '../../../../shared/reviewer'

const session = (overrides: Partial<ChatSession> = {}): ChatSession =>
  ({
    id: 'session-a',
    projectId: 'project-a',
    title: 'SHANK2 分析',
    messages: [],
    activities: [
      {
        id: 'activity-1',
        kind: 'tool',
        title: 'Run notebook cell',
        status: 'completed',
        sortIndex: 0,
        eventIds: [],
        providerToolName: 'notebook_run',
        toolLocations: [{ path: 'out/deg.csv', line: 3 }],
        createdAt: 0,
        updatedAt: 0
      }
    ],
    ...overrides
  }) as unknown as ChatSession

const review = (overrides: Partial<ReviewWithChecks> = {}): ReviewWithChecks =>
  ({
    id: 'review-1',
    projectId: 'project-a',
    sessionId: 'session-a',
    turnMessageId: 'turn-1',
    checks: [
      {
        id: 'check-1',
        reviewId: 'review-1',
        status: 'warn',
        resolution: 'open',
        claim: '声称已跑全量',
        evidence: '日志只有降采样',
        sortIndex: 0,
        reflagCount: 0
      }
    ],
    ...overrides
  }) as unknown as ReviewWithChecks

const pin: ReviewEvidenceAttachment = {
  schemaVersion: 1,
  id: 'pin-1',
  reviewId: 'review-1',
  projectId: 'project-a',
  sessionId: 'session-a',
  messageId: 'message-2',
  role: 'agent',
  fingerprint: `sha256:${'a'.repeat(64)}`,
  query: 'sin csv',
  terms: ['sin', 'csv'],
  snippet: 'wrote sin(x) values',
  capturedAt: '2026-09-14T10:00:00.000Z'
}

const build = (
  overrides: Partial<Parameters<typeof buildTraceExportFromSession>[0]> = {}
): ReturnType<typeof buildTraceExportFromSession> =>
  buildTraceExportFromSession({
    session: session(),
    reviews: [review()],
    pins: [pin],
    generatedAt: '2026-09-14T12:00:00.000Z',
    ...overrides
  })

describe('buildTraceExportFromSession', () => {
  it('turns recorded activities into steps with their own status and evidence handle', () => {
    const document = build()

    expect(document.steps).toEqual([
      {
        label: 'Run notebook cell',
        status: 'done',
        detail: 'notebook_run',
        evidence: 'out/deg.csv:3'
      }
    ])
  })

  it('takes model findings from the reviewer checks', () => {
    const document = build()

    expect(document.findings).toEqual([
      { claim: '声称已跑全量', status: 'warn', evidence: '日志只有降采样' }
    ])
  })

  it('takes human evidence from the pins, with what makes it checkable', () => {
    const document = build()

    expect(document.humanEvidence).toEqual([
      {
        snippet: 'wrote sin(x) values',
        fingerprint: `sha256:${'a'.repeat(64)}`,
        role: 'agent',
        query: 'sin csv',
        terms: ['sin', 'csv'],
        capturedAt: '2026-09-14T10:00:00.000Z'
      }
    ])
  })

  it('omits both evidence sections when a session has neither', () => {
    const document = build({ reviews: [], pins: [] })

    expect(document.findings).toBeUndefined()
    expect(document.humanEvidence).toBeUndefined()
  })

  it('handles a session with no recorded activities honestly', () => {
    const document = build({ session: session({ activities: [] }) })

    expect(document.steps).toEqual([])
  })
})
