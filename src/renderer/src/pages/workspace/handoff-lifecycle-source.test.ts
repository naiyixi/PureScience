// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'

import type {
  HandoffLifecycleChange,
  HandoffLifecycleEvent
} from '../../../../shared/handoff-lifecycle'

import { IpcHandoffLifecycleClient } from './handoff-lifecycle-source'

const event = (sequence: number, phase: HandoffLifecycleEvent['phase']): HandoffLifecycleEvent => ({
  id: 'handoff-1',
  sessionId: 'session-1',
  sequence,
  observedAt: sequence,
  phase,
  target: { kind: 'main' },
  provenance: {
    originatingTurnId: 'turn-1',
    originatingUserMessageId: 'user-1',
    attachmentIds: [],
    artifactIds: []
  }
})

describe('IPC handoff lifecycle client', () => {
  it('keeps the empty event snapshot stable before a session has handoff events', () => {
    const api = {
      list: vi.fn(async () => []),
      retry: vi.fn(async () => undefined),
      onChanged: vi.fn(() => () => undefined)
    }
    const client = new IpcHandoffLifecycleClient(() => api)

    expect(client.getEvents('session-1')).toBe(client.getEvents('session-1'))
  })

  it('hydrates retained events from the lifecycle face, follows upserts, and forwards only a retry intent', async () => {
    let onChanged: ((change: HandoffLifecycleChange) => void) | undefined
    const api = {
      list: vi.fn(async () => [event(1, 'switching')]),
      retry: vi.fn(async () => undefined),
      onChanged: vi.fn((listener: typeof onChanged) => {
        onChanged = listener
        return () => {
          onChanged = undefined
        }
      })
    }
    const client = new IpcHandoffLifecycleClient(() => api)
    const listener = vi.fn()
    client.subscribe(listener)

    await client.load('session-1')
    onChanged?.({ kind: 'upsert', event: event(2, 'reconfiguring') })
    await client.retry({ sessionId: 'session-1', originatingTurnId: 'turn-1' })

    expect(client.getEvents('session-1').map((item) => item.phase)).toEqual(['reconfiguring'])
    expect(listener).toHaveBeenCalledTimes(2)
    expect(api.list).toHaveBeenCalledWith({ sessionId: 'session-1' })
    // The coordinator resolves the handoff from the originating turn itself, so the renderer sends the
    // intent and nothing else.
    expect(api.retry).toHaveBeenCalledWith({
      sessionId: 'session-1',
      originatingTurnId: 'turn-1'
    })
  })

  it('removes a declined approval card from the live lifecycle projection', async () => {
    let onChanged: ((change: HandoffLifecycleChange) => void) | undefined
    const api = {
      list: vi.fn(async () => [event(1, 'awaiting-approval')]),
      retry: vi.fn(async () => undefined),
      onChanged: vi.fn((listener: typeof onChanged) => {
        onChanged = listener
        return () => undefined
      })
    }
    const client = new IpcHandoffLifecycleClient(() => api)
    client.subscribe(vi.fn())
    await client.load('session-1')

    onChanged?.({ kind: 'remove', sessionId: 'session-1', eventIds: ['handoff-1'] })
    expect(client.getEvents('session-1')).toEqual([])
  })
})
