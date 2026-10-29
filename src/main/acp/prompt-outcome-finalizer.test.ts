import type { PromptResponse } from '@agentclientprotocol/sdk'
import { describe, expect, it, vi } from 'vitest'

// The turn's usage is now logged as well as published on the stop event: the log is the second source
// that makes "reconcile usage against the logs" possible at all (before it, main.log carried no token
// numbers). These spies are how the test proves the line is emitted with the same fields.
const loggerSpies = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }))
vi.mock('../logger', () => ({
  createLogger: () => loggerSpies,
  errorLogFields: (error: unknown) => ({ error: String(error) })
}))

import type { AcpRuntimeEvent } from '../../shared/acp'
import type { ContextUsageTurnHandle } from './context-usage-tracker'
import {
  AcpPromptOutcomeFinalizer,
  type AcpPromptFinalizationHandles,
  type AcpPromptFinalizationOutcome
} from './prompt-outcome-finalizer'
import { AcpSessionInteractionOwner } from './session-interaction-owner'
import type { AcpPromptSessionInteractionScope } from './session-interaction-owner'

type MutableHandles = {
  -readonly [Key in keyof AcpPromptFinalizationHandles]: AcpPromptFinalizationHandles[Key]
}

const deferred = <T = void>(): {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
} => {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const createHarness = (
  options: { now?: () => number } = {}
): {
  context: ContextUsageTurnHandle
  events: Array<Partial<AcpRuntimeEvent>>
  handles: MutableHandles
  interaction: AcpPromptSessionInteractionScope
  interactions: AcpSessionInteractionOwner
  journal: string[]
} => {
  const journal: string[] = []
  const events: Array<Partial<AcpRuntimeEvent>> = []
  const interactions = new AcpSessionInteractionOwner({ now: options.now })
  const interaction = interactions.claim({ sessionId: 's1', kind: 'prompt' })
  const context = {
    complete: vi.fn(() => {
      journal.push('context:complete')
      return true
    }),
    fail: vi.fn(() => journal.push('context:fail')),
    supersede: vi.fn(() => journal.push('context:supersede'))
  } as unknown as ContextUsageTurnHandle
  const handles = {
    sessionId: 's1',
    promptMessageId: 'prompt-1',
    interaction,
    interactions,
    permission: {
      clearCorrelationsForSession: vi.fn(() => journal.push('permission:clear'))
    },
    prepared: { close: vi.fn(() => journal.push('prepared:close')) },
    context,
    skill: {
      reloadDecision: { kind: 'continue' },
      close: vi.fn((outcome) => journal.push(`skill:${outcome}`))
    },
    model: 'test-model',
    emitUserMessage: vi.fn(() => journal.push('user')),
    emitArtifact: vi.fn(async (onPublished) => {
      journal.push('artifact:publish')
      onPublished()
    }),
    disposeArtifact: vi.fn(async () => {
      journal.push('artifact:dispose')
    }),
    failPendingSkillActivities: vi.fn(() => journal.push('skills:fail')),
    recordContextUsed: vi.fn((used) => journal.push(`context:used:${used}`)),
    errorMessage: (error) => (error instanceof Error ? error.message : String(error)),
    errorKind: (error) => (error as { data?: { errorKind?: string } } | undefined)?.data?.errorKind,
    pushEvent: vi.fn((event) => {
      events.push(event)
      journal.push(`event:${event.kind}`)
    }),
    emitState: vi.fn(() => journal.push('state')),
    beforeInteractionRelease: vi.fn(() => journal.push('interaction:before-release')),
    afterInteractionRelease: vi.fn(async () => {
      journal.push('interaction:after-release')
    }),
    onPromptEnded: vi.fn(() => journal.push('prompt:end')),
    generationActivityChanged: vi.fn(() => journal.push('activity')),
    autoCompactIfNeeded: vi.fn(async () => {
      journal.push('compact')
    })
  } satisfies AcpPromptFinalizationHandles
  return { context, events, handles, interaction, interactions, journal }
}

const stopped = (
  response: PromptResponse = { stopReason: 'end_turn' }
): AcpPromptFinalizationOutcome => ({
  kind: 'stopped',
  response,
  facts: {
    turnUsage: { inputTokens: 10, cacheTokens: 2, outputTokens: 3 },
    modelTurnCount: 4,
    contextUsedTokens: 12
  }
})

describe('AcpPromptOutcomeFinalizer', () => {
  it('logs the turn usage so the session document has a second source to reconcile against', async () => {
    const harness = createHarness({ now: () => 1234 })
    expect(harness.interactions.captureTerminal(harness.interaction, 'stop')).toBe(true)
    loggerSpies.info.mockClear()

    await new AcpPromptOutcomeFinalizer().finalize(harness.handles, stopped())

    const usageLine = loggerSpies.info.mock.calls.find(([message]) => message === 'prompt usage')
    expect(usageLine).toBeDefined()
    // Same fields the session document records: a line that dropped one of them could not be reconciled
    // field by field, which is the only reason this log exists.
    expect(usageLine?.[1]).toEqual({
      sessionId: 's1',
      inputTokens: 10,
      cacheTokens: 2,
      outputTokens: 3,
      turnCount: 4
    })
  })

  it('sequences provider facts, context, Artifact, stop publication, and cleanup', async () => {
    const harness = createHarness({ now: () => 1234 })
    expect(harness.interactions.captureTerminal(harness.interaction, 'stop')).toBe(true)

    await expect(
      new AcpPromptOutcomeFinalizer().finalize(harness.handles, stopped())
    ).resolves.toEqual({ stopReason: 'end_turn' })

    expect(harness.events).toEqual([
      expect.objectContaining({
        kind: 'stop',
        timestamp: 1234,
        turnUsage: {
          inputTokens: 10,
          cacheTokens: 2,
          outputTokens: 3,
          turnCount: 4
        }
      })
    ])
    expect(harness.journal).toEqual([
      'context:used:12',
      'context:complete',
      'state',
      'artifact:publish',
      'event:stop',
      'compact',
      'prepared:close',
      'artifact:dispose',
      'interaction:before-release',
      'permission:clear',
      'context:supersede',
      'interaction:after-release',
      'prompt:end',
      'state',
      'skill:completed',
      'activity'
    ])
    expect(harness.interactions.current('s1')).toBeUndefined()
  })

  it('keeps the captured terminal timestamp while Artifact publication is slow', async () => {
    let now = 100
    const harness = createHarness({ now: () => now })
    const artifactStarted = deferred()
    const releaseArtifact = deferred()
    harness.handles.emitArtifact = vi.fn(async (onPublished) => {
      artifactStarted.resolve()
      await releaseArtifact.promise
      onPublished()
    })
    expect(harness.interactions.captureTerminal(harness.interaction, 'stop')).toBe(true)

    const finalization = new AcpPromptOutcomeFinalizer().finalize(harness.handles, stopped())
    await artifactStarted.promise
    now = 999
    releaseArtifact.resolve()
    await finalization

    expect(harness.events).toContainEqual(expect.objectContaining({ kind: 'stop', timestamp: 100 }))
  })

  it('does not rewrite an observed stop when its callback throws and still cleans up once', async () => {
    const harness = createHarness()
    const callbackError = new Error('stop callback failed')
    harness.handles.pushEvent = vi.fn((event) => {
      harness.events.push(event)
      throw callbackError
    })
    harness.handles.onPromptEnded = vi.fn(() => {
      throw new Error('prompt-end callback failed')
    })
    harness.handles.prepared = {
      close: vi.fn(() => {
        throw new Error('prompt preparation cleanup failed')
      })
    }
    harness.handles.skill = {
      ...harness.handles.skill,
      close: vi.fn(() => {
        throw new Error('prompt skill cleanup failed')
      })
    }
    const clearPermission = harness.handles.permission.clearCorrelationsForSession
    harness.handles.permission = {
      clearCorrelationsForSession: vi.fn((sessionId) => {
        clearPermission(sessionId)
        throw new Error('permission cleanup failed')
      })
    }
    harness.handles.context = {
      ...harness.context,
      supersede: vi.fn(() => {
        harness.context.supersede()
        throw new Error('context cleanup failed')
      })
    }
    harness.handles.interactions = {
      captureTerminal: harness.interactions.captureTerminal.bind(harness.interactions),
      current: harness.interactions.current.bind(harness.interactions),
      isCancellationAccepted: harness.interactions.isCancellationAccepted.bind(
        harness.interactions
      ),
      settle: harness.interactions.settle.bind(harness.interactions),
      release: vi.fn((scope) => {
        harness.interactions.release(scope)
        throw new Error('interaction cleanup failed')
      })
    }
    harness.handles.beforeInteractionRelease = vi.fn(() => {
      throw new Error('interaction pre-release failed')
    })
    harness.handles.afterInteractionRelease = vi.fn(async () => {
      throw new Error('interaction post-release failed')
    })
    expect(harness.interactions.captureTerminal(harness.interaction, 'stop')).toBe(true)

    await expect(new AcpPromptOutcomeFinalizer().finalize(harness.handles, stopped())).rejects.toBe(
      callbackError
    )

    expect(harness.events.map((event) => event.kind)).toEqual(['stop'])
    expect(harness.handles.prepared.close).toHaveBeenCalledOnce()
    expect(harness.handles.disposeArtifact).toHaveBeenCalledOnce()
    expect(harness.handles.beforeInteractionRelease).toHaveBeenCalledOnce()
    expect(harness.handles.afterInteractionRelease).toHaveBeenCalledOnce()
    expect(harness.handles.permission.clearCorrelationsForSession).toHaveBeenCalledOnce()
    expect(harness.context.supersede).toHaveBeenCalledOnce()
    expect(harness.handles.onPromptEnded).toHaveBeenCalledOnce()
    expect(harness.handles.skill.close).toHaveBeenCalledOnce()
    expect(harness.handles.generationActivityChanged).toHaveBeenCalledOnce()
  })

  it('retries Artifact publication before the observed stop', async () => {
    const harness = createHarness()
    const artifactError = new Error('temporary Artifact failure')
    harness.handles.emitArtifact = vi
      .fn<(onPublished: () => void) => Promise<void>>()
      .mockRejectedValueOnce(artifactError)
      .mockImplementationOnce(async (onPublished) => {
        harness.journal.push('event:artifact')
        onPublished()
      })
    expect(harness.interactions.captureTerminal(harness.interaction, 'stop')).toBe(true)

    await expect(new AcpPromptOutcomeFinalizer().finalize(harness.handles, stopped())).rejects.toBe(
      artifactError
    )

    expect(harness.handles.emitArtifact).toHaveBeenCalledTimes(2)
    expect(harness.journal.indexOf('event:artifact')).toBeLessThan(
      harness.journal.indexOf('event:stop')
    )
  })

  it('does not replay an Artifact appended before its callback failed', async () => {
    const harness = createHarness()
    const callbackError = new Error('artifact callback failed')
    harness.handles.emitArtifact = vi.fn(async (onPublished) => {
      harness.journal.push('event:artifact')
      onPublished()
      throw callbackError
    })
    expect(harness.interactions.captureTerminal(harness.interaction, 'stop')).toBe(true)

    await expect(new AcpPromptOutcomeFinalizer().finalize(harness.handles, stopped())).rejects.toBe(
      callbackError
    )

    expect(harness.handles.emitArtifact).toHaveBeenCalledOnce()
    expect(harness.journal.filter((entry) => entry === 'event:artifact')).toHaveLength(1)
    expect(harness.journal.indexOf('event:artifact')).toBeLessThan(
      harness.journal.indexOf('event:stop')
    )
  })

  it.each([
    {
      name: 'context overflow',
      error: Object.assign(new Error('Internal error'), {
        data: { errorKind: 'request_too_large' }
      }),
      recoverable: 'context-overflow',
      providerError: false
    },
    {
      name: 'provider error',
      error: Object.assign(new Error('Invalid API key'), { data: { errorName: 'APIError' } }),
      // A rejected provider is something the user can act on - the key, or the provider itself - so the
      // failure now carries the tag the panel turns into that sentence.
      recoverable: 'provider-unreachable',
      providerError: true
    },
    {
      name: 'ACP error',
      error: new Error('protocol failed'),
      recoverable: undefined,
      providerError: false
    }
  ])('classifies a fresh $name and cleans up once', async (testCase) => {
    const harness = createHarness({ now: () => 321 })
    harness.handles.failPendingSkillActivities = vi.fn(() => {
      throw new Error('skill activity callback failed')
    })

    await expect(
      new AcpPromptOutcomeFinalizer().finalize(harness.handles, {
        kind: 'failed',
        error: testCase.error
      })
    ).rejects.toBe(testCase.error)

    expect(harness.events).toContainEqual(
      expect.objectContaining({
        kind: 'error',
        timestamp: 321,
        recoverable: testCase.recoverable,
        providerError: testCase.providerError
      })
    )
    expect(harness.context.fail).toHaveBeenCalledOnce()
    expect(harness.handles.failPendingSkillActivities).toHaveBeenCalledOnce()
    expect(harness.context.supersede).toHaveBeenCalledOnce()
    expect(harness.handles.skill.close).toHaveBeenCalledWith('failed')
  })

  it('keeps a replacement interaction current when the old provider outcome is superseded', async () => {
    const harness = createHarness()
    harness.interactions.supersede(harness.interaction)
    const replacement = harness.interactions.claim({ sessionId: 's1', kind: 'prompt' })

    await expect(
      new AcpPromptOutcomeFinalizer().finalize(harness.handles, {
        kind: 'superseded',
        response: { stopReason: 'cancelled' }
      })
    ).resolves.toEqual({ stopReason: 'cancelled' })

    expect(harness.interactions.current('s1')).toBe(replacement)
    expect(harness.events).toEqual([])
    expect(harness.handles.permission.clearCorrelationsForSession).not.toHaveBeenCalled()
    expect(harness.handles.onPromptEnded).not.toHaveBeenCalled()
    expect(harness.context.supersede).toHaveBeenCalledOnce()
  })

  it('publishes a cancelled stop for a current prompt that was not dispatched', async () => {
    const harness = createHarness({ now: () => 456 })

    await expect(
      new AcpPromptOutcomeFinalizer().finalize(harness.handles, {
        kind: 'not-dispatched'
      })
    ).resolves.toEqual({ stopReason: 'cancelled' })

    expect(harness.handles.emitUserMessage).toHaveBeenCalledOnce()
    expect(harness.events).toContainEqual(
      expect.objectContaining({ kind: 'stop', timestamp: 456, text: 'cancelled' })
    )
    expect(harness.context.fail).toHaveBeenCalledOnce()
    expect(harness.handles.skill.close).toHaveBeenCalledWith('cancelled')
  })

  // Measured 2026-10-29: three prompts in a row ended with `stopReason: refusal`, the runtime produced no
  // answer, and the surface showed nothing at all — the only trace was an info-level log line. A refusal
  // must reach the reader as an error with the remedy stated, not as silence.
  it('surfaces a refusal as a visible error, not as silence', async () => {
    const harness = createHarness()
    // The executor captures the terminal before the finalizer settles it; without that the settle is a
    // no-op and no stop row can be published (this is the same wiring the ordering test relies on).
    harness.interactions.captureTerminal(harness.interaction, 'stop')

    await expect(
      new AcpPromptOutcomeFinalizer().finalize(harness.handles, stopped({ stopReason: 'refusal' }))
    ).resolves.toEqual({ stopReason: 'refusal' })

    // The stop row still publishes (the timeline keeps its "Prompt stopped" fact)…
    expect(harness.events).toContainEqual(
      expect.objectContaining({ kind: 'stop', text: 'refusal' })
    )
    // …and a refusal adds one error row that says what happened and what to do.
    const refusal = harness.events.filter(
      (event) => event.kind === 'error' && /refused/i.test(String(event.title ?? ''))
    )
    expect(refusal).toHaveLength(1)
    expect(String(refusal[0].text ?? '')).toMatch(/switch|rephras/i)
  })

  it('does not add a refusal note for an ordinary end of turn', async () => {
    const harness = createHarness()

    await new AcpPromptOutcomeFinalizer().finalize(harness.handles, stopped({ stopReason: 'end_turn' }))

    expect(harness.events.filter((event) => event.kind === 'error')).toHaveLength(0)
  })

  it('treats a failure on a user-cancelled interaction as a normal cancellation', async () => {
    const harness = createHarness({ now: () => 789 })
    harness.handles.interactions = Object.assign(harness.handles.interactions, {
      isCancellationAccepted: () => true
    })

    // Claude Code 2.1.220 answers an interrupt with an internal error
    // (`ede_diagnostic result_type=user stop_reason=tool_use`) instead of a clean
    // `cancelled` stop — the finalizer must surface that as cancelled, not failed.
    await expect(
      new AcpPromptOutcomeFinalizer().finalize(harness.handles, {
        kind: 'failed',
        error: new Error(
          'RequestError: Internal error: [ede_diagnostic] result_type=user stop_reason=tool_use'
        )
      })
    ).resolves.toEqual({ stopReason: 'cancelled' })

    expect(harness.handles.emitUserMessage).toHaveBeenCalledOnce()
    expect(harness.events).toContainEqual(
      expect.objectContaining({ kind: 'stop', timestamp: 789, text: 'cancelled' })
    )
    expect(harness.context.fail).toHaveBeenCalledOnce()
    expect(harness.handles.skill.close).toHaveBeenCalledWith('cancelled')
  })

  it('still throws a real failure when the interaction was not cancelled', async () => {
    const harness = createHarness()
    await expect(
      new AcpPromptOutcomeFinalizer().finalize(harness.handles, {
        kind: 'failed',
        error: new Error('provider connection lost')
      })
    ).rejects.toThrow('provider connection lost')
  })
})
