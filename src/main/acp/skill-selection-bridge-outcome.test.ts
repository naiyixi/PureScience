import { describe, expect, it, vi } from 'vitest'

import { createSkillSelectionBridge } from './runtime-prompt-composition'

// The turn path used to report a failed selection as `used-model` — the same label a real answer gets — so
// the trail claimed a call that never succeeded. These cases pin the three outcomes apart.

const catalog = [{ name: 'pubmed-search', description: 'Search PubMed' }] as never
const fallback = { kind: 'built-in-deterministic' as const, detailKey: 'settings.fallback' }
const override = { providerId: 'p_1', model: 'm_1' }

const hostWith = (recordFunctionModelEvent: ReturnType<typeof vi.fn>): never =>
  ({
    resolveFunctionModelTarget: vi.fn(async () => ({
      resolution: { functionId: 'skill-selection', override, fallback, unusable: [] },
      target: { baseUrl: 'https://vendor.example/v1', model: 'm_1' }
    })),
    recordFunctionModelEvent
  }) as never

describe('skill selection outcome reaches the trail as what actually happened', () => {
  it('records call-failed when the call failed, instead of used-model', async () => {
    const record = vi.fn()
    const bridge = createSkillSelectionBridge({
      functionModels: hostWith(record),
      select: vi.fn(async () => []) as never,
      skillSelectionOutcome: () => 'failed'
    })

    await bridge('find papers', catalog)

    expect(record).toHaveBeenCalledWith({
      functionId: 'skill-selection',
      outcome: 'built-in',
      reason: 'call-failed',
      providerId: override.providerId,
      model: override.model
    })
  })

  it('records call-not-attempted when nothing was asked for', async () => {
    const record = vi.fn()
    const bridge = createSkillSelectionBridge({
      functionModels: hostWith(record),
      select: vi.fn(async () => []) as never,
      skillSelectionOutcome: () => 'skipped'
    })

    await bridge('find papers', catalog)

    expect(record).toHaveBeenCalledWith({
      functionId: 'skill-selection',
      outcome: 'built-in',
      reason: 'call-not-attempted',
      providerId: override.providerId,
      model: override.model
    })
  })

  it('still records used-model when the model really answered', async () => {
    const record = vi.fn()
    const bridge = createSkillSelectionBridge({
      functionModels: hostWith(record),
      select: vi.fn(async () => []) as never,
      skillSelectionOutcome: () => 'answered'
    })

    await bridge('find papers', catalog)

    expect(record).toHaveBeenCalledWith({
      functionId: 'skill-selection',
      outcome: 'used-model',
      providerId: override.providerId,
      model: override.model
    })
  })
})
