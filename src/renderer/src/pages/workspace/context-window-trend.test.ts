import { describe, expect, it } from 'vitest'

import type { AcpContextWindowSample } from '../../../../shared/acp'
import type { PersistedRuntimeSegment } from '../../../../shared/conversation-graph'
import type { ChatSession } from '@/stores/session-store'
import { selectContextWindowTrendPoints } from './context-window-trend'

const makeSample = (overrides: Partial<AcpContextWindowSample> = {}): AcpContextWindowSample => ({
  id: overrides.id ?? 'sample-1',
  timestamp: overrides.timestamp ?? 1000,
  termination: overrides.termination ?? { kind: 'stop', stopReason: 'end_turn' },
  contextWindow: overrides.contextWindow ?? { used: 100, size: 200 },
  source: overrides.source ?? 'provider-response',
  ...overrides
})

const makeRuntime = (
  overrides: Partial<PersistedRuntimeSegment> = {}
): PersistedRuntimeSegment => ({
  id: 'runtime-1',
  frameworkId: 'claude-code',
  agentFrameId: 'frame-1',
  backendId: 'backend-1',
  agentName: 'Main Agent',
  model: 'claude-sonnet',
  startedAt: 500,
  ...overrides
})

const makeSession = (overrides: Partial<ChatSession> = {}): ChatSession =>
  ({
    id: 'session-1',
    messages: [],
    activities: [],
    activityGroups: [],
    conversationGraph: {
      version: 1,
      runtimeSegments: [makeRuntime()],
      messages: [],
      frames: [{ id: 'frame-1', kind: 'root', agentName: 'Main Agent' }]
    },
    ...overrides
  }) as unknown as ChatSession

describe('selectContextWindowTrendPoints', () => {
  it('returns [] for an undefined session', () => {
    expect(selectContextWindowTrendPoints(undefined)).toEqual([])
  })

  it('collects one point per visible user-message sample, in timestamp order', () => {
    const session = makeSession({
      messages: [
        {
          id: 'user-1',
          role: 'user',
          content: 'first prompt',
          status: 'complete',
          createdAt: 1,
          updatedAt: 1,
          eventIds: [],
          contextWindowSamples: [
            makeSample({ id: 's2', timestamp: 2000, runtimeSegmentId: 'runtime-1' })
          ]
        },
        {
          id: 'agent-1',
          role: 'agent',
          content: 'reply',
          status: 'complete',
          createdAt: 1,
          updatedAt: 1,
          eventIds: []
        }
      ] as never
    })
    const points = selectContextWindowTrendPoints(session)
    expect(points).toHaveLength(1)
    expect(points[0]).toMatchObject({
      runNumber: 1,
      messageNumber: 1,
      promptMessageId: 'user-1',
      prompt: 'first prompt'
    })
    expect(points[0]?.sample.id).toBe('s2')
    expect(points[0]?.agentName).toBe('Main Agent')
    expect(points[0]?.compactedAfter).toBe(false)
  })

  it('hides non-terminal samples except the latest completed end_turn sample', () => {
    const session = makeSession({
      messages: [
        {
          id: 'user-1',
          role: 'user',
          content: 'prompt',
          status: 'complete',
          createdAt: 1,
          updatedAt: 1,
          eventIds: [],
          contextWindowSamples: [
            makeSample({ id: 's-first-end', timestamp: 2000 }),
            makeSample({ id: 's-latest', timestamp: 3000 })
          ]
        }
      ] as never
    })
    const points = selectContextWindowTrendPoints(session)
    // Non-terminal snapshots stay visible; only earlier end_turn samples are collapsed.
    expect(points.map((point) => point.sample.id)).toEqual(['s-latest'])
  })

  it('marks the last point of a completed compaction prompt as compactedAfter', () => {
    const session = makeSession({
      messages: [
        {
          id: 'user-1',
          role: 'user',
          content: 'compacting prompt',
          status: 'complete',
          createdAt: 1,
          updatedAt: 1,
          eventIds: [],
          contextWindowSamples: [makeSample({ id: 's1' })]
        }
      ],
      activities: [
        {
          id: 'activity-1',
          providerToolName: 'ContextCompaction',
          status: 'completed',
          title: 'Context compacted',
          promptMessageId: 'user-1',
          kind: 'tool'
        }
      ]
    } as never)
    const points = selectContextWindowTrendPoints(session)
    expect(points[0]?.compactedAfter).toBe(true)
  })

  it('does not mark compaction when the activity belongs to a different prompt', () => {
    const session = makeSession({
      messages: [
        {
          id: 'user-1',
          role: 'user',
          content: 'prompt',
          status: 'complete',
          createdAt: 1,
          updatedAt: 1,
          eventIds: [],
          contextWindowSamples: [makeSample({ id: 's1' })]
        }
      ],
      activities: [
        {
          id: 'activity-1',
          providerToolName: 'ContextCompaction',
          status: 'completed',
          title: 'Context compacted',
          promptMessageId: 'user-other',
          kind: 'tool'
        }
      ]
    } as never)
    const points = selectContextWindowTrendPoints(session)
    expect(points[0]?.compactedAfter).toBe(false)
  })

  it('resolves runtime metadata from the conversation graph by runtimeSegmentId', () => {
    const session = makeSession({
      messages: [
        {
          id: 'user-1',
          role: 'user',
          content: 'prompt',
          status: 'complete',
          createdAt: 1,
          updatedAt: 1,
          eventIds: [],
          contextWindowSamples: [makeSample({ id: 's1', runtimeSegmentId: 'runtime-1' })]
        }
      ]
    } as never)
    const points = selectContextWindowTrendPoints(session)
    expect(points[0]?.runtime?.id).toBe('runtime-1')
    expect(points[0]?.runtime?.model).toBe('claude-sonnet')
  })

  it('sorts samples across messages by timestamp', () => {
    const session = makeSession({
      messages: [
        {
          id: 'user-2',
          role: 'user',
          content: 'second',
          status: 'complete',
          createdAt: 1,
          updatedAt: 1,
          eventIds: [],
          contextWindowSamples: [
            makeSample({ id: 's2', timestamp: 2000, runtimeSegmentId: 'runtime-1' })
          ]
        },
        {
          id: 'user-1',
          role: 'user',
          content: 'first',
          status: 'complete',
          createdAt: 1,
          updatedAt: 1,
          eventIds: [],
          contextWindowSamples: [makeSample({ id: 's1', timestamp: 1000 })]
        }
      ]
    } as never)
    const points = selectContextWindowTrendPoints(session)
    expect(points.map((point) => point.sample.id)).toEqual(['s1', 's2'])
    expect(points.map((point) => point.runNumber)).toEqual([1, 2])
  })
})
