import { describe, expect, it } from 'vitest'

import type { PersistedChatMessage, PersistedToolActivity } from './session-persistence'
import { buildSessionReplay } from './session-replay-steps'

const message = (over: Partial<PersistedChatMessage> & { id: string }): PersistedChatMessage =>
  ({
    role: 'user',
    content: over.id,
    status: 'complete',
    eventIds: [],
    ...over
  }) as PersistedChatMessage

const activity = (
  over: Partial<PersistedToolActivity> & { id: string; sortIndex: number }
): PersistedToolActivity =>
  ({
    kind: 'tool',
    title: over.id,
    status: 'completed',
    eventIds: [],
    createdAt: 0,
    ...over
  }) as PersistedToolActivity

describe('buildSessionReplay', () => {
  it('lists each prompt followed by the tool calls recorded under it', () => {
    const steps = buildSessionReplay({
      messages: [message({ id: 'u1' }), message({ id: 'u2', role: 'agent' })],
      activities: [
        activity({ id: 't2', promptMessageId: 'u1', sortIndex: 2, providerToolName: 'run_python' }),
        activity({ id: 't1', promptMessageId: 'u1', sortIndex: 1 })
      ]
    })

    expect(steps.map((step) => step.id)).toEqual(['prompt:u1', 'tool:t1', 'tool:t2'])
    // The provider's tool name is only present when the session recorded one.
    expect(steps[1]?.toolName).toBeUndefined()
    expect(steps[2]?.toolName).toBe('run_python')
  })

  it('orders activity groups by the prompt they belong to, then by the recorded sort index', () => {
    const steps = buildSessionReplay({
      messages: [message({ id: 'u1' }), message({ id: 'u2' })],
      activities: [
        activity({ id: 'b', promptMessageId: 'u2', sortIndex: 0 }),
        activity({ id: 'a2', promptMessageId: 'u1', sortIndex: 1 }),
        activity({ id: 'a1', promptMessageId: 'u1', sortIndex: 0 })
      ]
    })

    expect(steps.map((step) => step.id)).toEqual([
      'prompt:u1',
      'tool:a1',
      'tool:a2',
      'prompt:u2',
      'tool:b'
    ])
  })

  it('keeps a tool call whose prompt is gone, and says it has no prompt', () => {
    const steps = buildSessionReplay({
      messages: [message({ id: 'u1' })],
      activities: [activity({ id: 'orphan', promptMessageId: 'u-deleted', sortIndex: 0 })]
    })

    const orphan = steps.find((step) => step.id === 'tool:orphan')
    expect(orphan).toBeDefined()
    // No fabricated prompt link: the step keeps its own id as the anchor instead.
    expect(orphan?.promptMessageId).toBeUndefined()
    expect(orphan?.messageId).toBe('orphan')
    expect(steps).toHaveLength(2)
  })

  it('carries the prompt artifacts onto the prompt step and nothing it was not given', () => {
    const steps = buildSessionReplay({
      messages: [message({ id: 'u1', artifactIds: ['artifact-1'] })],
      activities: [activity({ id: 't1', promptMessageId: 'u1', sortIndex: 0 })]
    })

    expect(steps[0]?.artifactIds).toEqual(['artifact-1'])
    expect(steps[1]?.artifactIds).toEqual([])
    expect(steps[1]?.createdAt).toBe(0)
  })

  it('returns an empty sequence for a session with no messages', () => {
    expect(buildSessionReplay({ messages: [] })).toEqual([])
  })

  it('carries the angles a step was recorded with, and stays silent about the ones it was not', () => {
    const steps = buildSessionReplay({
      messages: [message({ id: 'u1' })],
      activities: [
        activity({
          id: 'rich',
          promptMessageId: 'u1',
          sortIndex: 0,
          toolLocations: [{ path: '/tmp/out.csv' } as never],
          terminalExitCode: 0,
          terminalOutput: 'wrote 12 rows'
        }),
        activity({ id: 'bare', promptMessageId: 'u1', sortIndex: 1 })
      ]
    })

    const rich = steps.find((step) => step.id === 'tool:rich')
    expect(rich?.locations).toHaveLength(1)
    expect(rich?.terminalExitCode).toBe(0)
    expect(rich?.terminalOutput).toBe('wrote 12 rows')

    // Nothing was recorded for this one, so nothing is claimed about it.
    const bare = steps.find((step) => step.id === 'tool:bare')
    expect(bare?.locations).toBeUndefined()
    expect(bare?.terminalExitCode).toBeUndefined()
    expect(bare?.terminalOutput).toBeUndefined()
  })
})
