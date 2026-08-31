import { describe, expect, it } from 'vitest'

import { buildTokenUsageAnalytics } from './token-usage-analytics'
import type { PersistedChatSession } from '../../../../shared/session-persistence'

// Loose fixture builders — the analytics function only reads role/turnUsage/agentFrameId/createdAt
// from messages and id/kind/parentFrameId/createdAt/agentName from frames.

const agentMessage = (
  id: string,
  frameId: string,
  usage: { inputTokens: number; cacheTokens: number; outputTokens: number },
  createdAt: number
): Record<string, unknown> => ({
  id,
  parentId: null,
  agentFrameId: frameId,
  role: 'agent',
  content: 'work',
  turnUsage: usage,
  createdAt,
  completedAt: createdAt + 1,
  status: 'complete'
})

const humanMessage = (id: string, createdAt: number): Record<string, unknown> => ({
  id,
  parentId: null,
  agentFrameId: 'frame-root',
  role: 'human',
  content: 'go',
  createdAt
})

const sessionWithGraph = (
  messages: Record<string, unknown>[],
  frames: Record<string, unknown>[]
): PersistedChatSession =>
  ({
    id: 's1',
    title: 'S',
    createdAt: 1000,
    updatedAt: 2000,
    conversationGraph: {
      schemaVersion: 1,
      rootFrameId: 'frame-root',
      activeFrameId: 'frame-root',
      frames,
      branches: [],
      messages,
      activities: [],
      activityGroups: [],
      runtimeSegments: []
    },
    messages: []
  }) as unknown as PersistedChatSession

describe('buildTokenUsageAnalytics per-run attribution', () => {
  it('rolls up delegated sub-run tokens into the root run', () => {
    const root = {
      id: 'frame-root',
      kind: 'root',
      originBindingState: 'root',
      status: 'completed',
      activeBranchId: 'b1',
      createdAt: 1000
    }
    const delegate = {
      id: 'frame-delegate',
      kind: 'delegate',
      parentFrameId: 'frame-root',
      agentName: 'codex',
      originBindingState: 'root',
      status: 'completed',
      activeBranchId: 'b1',
      createdAt: 1100
    }
    const messages = [
      humanMessage('m1', 1000),
      agentMessage(
        'm2',
        'frame-root',
        { inputTokens: 100, cacheTokens: 50, outputTokens: 30 },
        1050
      ),
      agentMessage(
        'm3',
        'frame-delegate',
        { inputTokens: 400, cacheTokens: 0, outputTokens: 200 },
        1150
      )
    ]
    const analytics = buildTokenUsageAnalytics([sessionWithGraph(messages, [root, delegate])], 5000)

    const rootRun = analytics.runs.find((run) => run.frameId === 'frame-root')
    const delegateRun = analytics.runs.find((run) => run.frameId === 'frame-delegate')

    expect(rootRun).toBeDefined()
    expect(rootRun?.inputTokens).toBe(100)
    expect(rootRun?.outputTokens).toBe(30)
    expect(rootRun?.subRunCount).toBe(1)
    expect(rootRun?.subRunTokens).toBe(600) // 400 input + 200 output from the delegate
    expect((rootRun?.totalTokens ?? 0) + (rootRun?.subRunTokens ?? 0)).toBe(780)

    expect(delegateRun?.kind).toBe('delegate')
    expect(delegateRun?.parentFrameId).toBe('frame-root')
    expect(delegateRun?.totalTokens).toBe(600)
  })

  it('synthesizes one root run for a session without a graph', () => {
    const plainSession: PersistedChatSession = {
      id: 's2',
      title: 'P',
      createdAt: 1000,
      updatedAt: 2000,
      messages: [
        {
          id: 'm1',
          role: 'human',
          content: 'hi',
          createdAt: 1000
        },
        {
          id: 'm2',
          role: 'agent',
          content: 'ok',
          turnUsage: { inputTokens: 10, cacheTokens: 5, outputTokens: 7 },
          createdAt: 1100
        }
      ]
    } as unknown as PersistedChatSession
    const analytics = buildTokenUsageAnalytics([plainSession], 5000)
    expect(analytics.runs).toHaveLength(1)
    expect(analytics.runs[0].frameId).toBe('s2')
    expect(analytics.runs[0].totalTokens).toBe(22)
    expect(analytics.runs[0].subRunCount).toBe(0)
  })
})
