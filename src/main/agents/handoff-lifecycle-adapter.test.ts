import { describe, expect, it } from 'vitest'

import type { CompletionHandoffLifecycleEvent } from '../../shared/specialist'
import {
  toHandoffLifecycleChange,
  toHandoffLifecycleEvent,
  toHandoffTarget
} from './handoff-lifecycle-adapter'

const event = (
  overrides: Partial<CompletionHandoffLifecycleEvent> = {}
): CompletionHandoffLifecycleEvent => ({
  id: 'h1',
  sessionId: 's1',
  sequence: 4,
  commitOrder: 40,
  observedAt: 1_700_000_000_000,
  phase: 'continued',
  target: 'esm-fold',
  provenance: {
    originatingTurnId: 'turn-1',
    originatingUserMessageId: 'm1',
    attachmentIds: ['a1'],
    artifactIds: ['f1']
  },
  ...overrides
})

describe('handoff lifecycle adapter', () => {
  it('spells a null target as the main session, and a name as a specialist', () => {
    expect(toHandoffTarget(null)).toEqual({ kind: 'main' })
    expect(toHandoffTarget('esm-fold')).toEqual({ kind: 'specialist', name: 'esm-fold' })
  })

  it('carries the owner record across every field the seam asks for', () => {
    expect(toHandoffLifecycleEvent(event())).toEqual({
      id: 'h1',
      sessionId: 's1',
      sequence: 40,
      observedAt: 1_700_000_000_000,
      phase: 'continued',
      target: { kind: 'specialist', name: 'esm-fold' },
      provenance: {
        originatingTurnId: 'turn-1',
        originatingUserMessageId: 'm1',
        attachmentIds: ['a1'],
        artifactIds: ['f1']
      }
    })
  })

  it('orders by the repository stamp and falls back to the record sequence', () => {
    // The seam must never regress on a late event, so the globally monotonic stamp wins where it exists.
    expect(toHandoffLifecycleEvent(event({ commitOrder: 99, sequence: 4 })).sequence).toBe(99)
    expect(toHandoffLifecycleEvent(event({ commitOrder: undefined, sequence: 4 })).sequence).toBe(4)
  })

  it('reports an absent user-message id as empty rather than inventing one', () => {
    const legacy = event({
      provenance: {
        originatingTurnId: 'turn-1',
        attachmentIds: [],
        artifactIds: []
      }
    })
    expect(toHandoffLifecycleEvent(legacy).provenance.originatingUserMessageId).toBe('')
  })

  it('keeps a continuation only when the readback really carries a target', () => {
    const withReadback = event({
      continuation: { outcome: 'returned', switchReadback: { target: { kind: 'main' } } }
    })
    expect(toHandoffLifecycleEvent(withReadback).continuation).toEqual({
      outcome: 'returned',
      switchReadback: { target: { kind: 'main' } }
    })

    // The owner keeps the readback opaque: without a target there is nothing honest to report.
    const opaque = event({ continuation: { outcome: 'threw', switchReadback: { raw: 1 } } })
    expect(toHandoffLifecycleEvent(opaque).continuation).toBeUndefined()
  })

  it('narrows a thrown continuation and carries failures through', () => {
    const thrown = event({
      continuation: {
        outcome: 'threw',
        switchReadback: { target: { kind: 'specialist', name: 'x' } }
      },
      failure: { retryFrom: 'switching', message: 'boom' },
      phase: 'failed'
    })
    const mapped = toHandoffLifecycleEvent(thrown)
    expect(mapped.continuation?.outcome).toBe('threw')
    expect(mapped.failure).toEqual({ retryFrom: 'switching', message: 'boom' })
  })

  it('turns the owner removed flag into the seam remove change', () => {
    expect(toHandoffLifecycleChange(event({ removed: true }))).toEqual({
      kind: 'remove',
      sessionId: 's1',
      eventIds: ['h1']
    })
    expect(toHandoffLifecycleChange(event())).toEqual({
      kind: 'upsert',
      event: toHandoffLifecycleEvent(event())
    })
  })
})
