// The skill-selection decision itself, tested where it now lives. The bridge tests already cover the same
// branches through the turn path; these cover what only the helper can show — the measured time and the
// construction with no settings wiring at all.

import { describe, expect, it, vi } from 'vitest'

import type { FunctionModelEvent, FunctionModelEventReason } from '../../shared/function-models'
import {
  createProbeSkillSelection,
  runFunctionModelSkillSelection,
  type FunctionModelSkillSelectionHost
} from './function-model-skill-selection'

const host = (
  resolution: {
    override: { providerId: string; model: string } | null
    unusable: readonly FunctionModelEventReason[]
  },
  target: { baseUrl: string; key?: string; model?: string } | undefined = { baseUrl: 'http://x' }
): FunctionModelSkillSelectionHost & { events: Omit<FunctionModelEvent, 'at'>[] } => {
  const events: Omit<FunctionModelEvent, 'at'>[] = []

  return {
    resolveFunctionModelTarget: vi.fn().mockResolvedValue({
      resolution,
      target
    }) as unknown as FunctionModelSkillSelectionHost['resolveFunctionModelTarget'],
    recordFunctionModelEvent: vi.fn((event: Omit<FunctionModelEvent, 'at'>) => {
      events.push(event)
    }) as unknown as FunctionModelSkillSelectionHost['recordFunctionModelEvent'],
    events
  }
}

describe('createProbeSkillSelection', () => {
  const target = { baseUrl: 'https://gateway.example', key: 'k', model: 'm1' }
  const catalog = [{ name: 'alpha', description: 'does alpha', path: 'alpha' }]

  it('refuses to report a model that answered when the request never left', async () => {
    // The bridge answers an empty catalog with an empty list and never calls out; a probe that read that as
    // "the model answered" would be claiming a round trip that did not happen.
    const select = createProbeSkillSelection({ fetchImpl: vi.fn() })

    await expect(select(target, [])).rejects.toThrow('probe-not-attempted')
  })

  it('names an unreachable endpoint instead of reporting an empty selection', async () => {
    const select = createProbeSkillSelection({
      fetchImpl: vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED'))
    })

    await expect(select(target, catalog)).rejects.toThrow('probe-request-failed')
  })

  it('treats an error status as a failed call, not as a model that chose nothing', async () => {
    const select = createProbeSkillSelection({
      fetchImpl: vi.fn().mockResolvedValue({ ok: false, status: 401 } as unknown as Response)
    })

    await expect(select(target, catalog)).rejects.toThrow('http-401')
  })

  it('passes a real answer through, including one that selected nothing', async () => {
    const select = createProbeSkillSelection({
      fetchImpl: vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: '[]' } }] })
      } as unknown as Response)
    })

    // No throw: the model answered. "It selected nothing" is a legitimate answer, spelled by an empty list.
    await expect(select(target, catalog)).resolves.toEqual([])
  })
})

describe('runFunctionModelSkillSelection', () => {
  it('measures the call it actually made, including the built-in path', async () => {
    const clock = vi.fn().mockReturnValueOnce(1_000).mockReturnValueOnce(1_042)
    const configured = host({ override: { providerId: 'p1', model: 'm1' }, unusable: [] })

    const used = await runFunctionModelSkillSelection({
      functionId: 'skill-selection',
      host: configured,
      builtIn: async () => ['built-in'],
      runWithModel: async () => ['from-model'],
      now: clock
    })

    expect(used.value).toEqual(['from-model'])
    expect(used.selection).toMatchObject({ outcome: 'used-model', elapsedMs: 42 })
  })

  it('records nothing and reports the built-in path when there is no settings wiring', async () => {
    const result = await runFunctionModelSkillSelection({
      functionId: 'skill-selection',
      builtIn: async () => ['built-in'],
      runWithModel: async () => ['from-model']
    })

    // No host means no configured model in this construction — not a fallback that should be reported as
    // one, and no trail to write it into.
    expect(result.value).toEqual(['built-in'])
    expect(result.selection).toEqual({ outcome: 'built-in', elapsedMs: 0 })
  })

  it('keeps the caller alive and names the failure when the configured model throws', async () => {
    const configured = host({ override: { providerId: 'p1', model: 'm1' }, unusable: [] })

    const result = await runFunctionModelSkillSelection({
      functionId: 'skill-selection',
      host: configured,
      builtIn: async () => ['built-in'],
      runWithModel: async () => {
        throw new Error('unreachable')
      }
    })

    expect(result.value).toEqual(['built-in'])
    expect(result.selection).toMatchObject({
      outcome: 'built-in',
      reason: 'call-failed',
      providerId: 'p1',
      model: 'm1'
    })
    expect(configured.events.at(-1)).toMatchObject({ outcome: 'built-in', reason: 'call-failed' })
  })

  it('lets a caller name a failure more precisely than "it threw"', async () => {
    // The probe distinguishes a call that failed from one that was never attempted; both reach the helper
    // as a throw, so the caller decides the word.
    const configured = host({ override: { providerId: 'p1', model: 'm1' }, unusable: [] })

    const result = await runFunctionModelSkillSelection({
      functionId: 'skill-selection',
      host: configured,
      builtIn: async () => ['built-in'],
      runWithModel: async () => {
        throw new Error('probe-not-attempted')
      },
      classifyRunFailure: (error) =>
        error instanceof Error && error.message === 'probe-not-attempted'
          ? 'call-not-attempted'
          : 'call-failed'
    })

    expect(result.selection.reason).toBe('call-not-attempted')
    expect(configured.events.at(-1)).toMatchObject({ reason: 'call-not-attempted' })
  })

  it('separates "nobody configured it" from "the configured one cannot be used"', async () => {
    const none = host({ override: null, unusable: [] })
    const unusable = host({ override: null, unusable: ['provider-has-no-credentials'] })

    const first = await runFunctionModelSkillSelection({
      functionId: 'skill-selection',
      host: none,
      builtIn: async () => [],
      runWithModel: async () => []
    })
    const second = await runFunctionModelSkillSelection({
      functionId: 'skill-selection',
      host: unusable,
      builtIn: async () => [],
      runWithModel: async () => []
    })

    expect(first.selection.reason).toBe('not-configured')
    expect(second.selection.reason).toBe('provider-has-no-credentials')
  })
})
