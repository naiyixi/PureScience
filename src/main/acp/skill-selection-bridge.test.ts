import { describe, expect, it, vi } from 'vitest'

import { createSkillSelectionBridge } from './runtime-prompt-composition'

// The branch that chooses between the configured model and the built-in path is exactly where a silent
// fallback would hide, so it is tested on its own rather than through a whole prompt preparation.

const catalog = [{ name: 'pubmed-search', description: 'Search PubMed' }] as never
const selected = [{ name: 'pubmed-search' }] as never

const fallback = { kind: 'built-in-deterministic' as const, detailKey: 'settings.fallback' }

const resolution = (
  override: { providerId: string; model: string } | null,
  unusable: string[] = []
): never => ({ functionId: 'skill-selection', override, fallback, unusable }) as never

const build = ({
  functionModels,
  select
}: {
  functionModels?: unknown
  select: ReturnType<typeof vi.fn>
}): ReturnType<typeof createSkillSelectionBridge> =>
  createSkillSelectionBridge({
    ...(functionModels ? { functionModels: functionModels as never } : {}),
    select: select as never
  })

describe('createSkillSelectionBridge', () => {
  it('keeps the plain call shape when settings are not wired at all', async () => {
    const select = vi.fn(async () => selected)
    const bridge = build({ select })

    await expect(bridge('search pubmed', catalog)).resolves.toEqual(selected)
    // Three arguments, exactly as before this feature existed: nothing about the call changed.
    expect(select).toHaveBeenCalledWith('search pubmed', catalog, undefined)
  })

  it('records the built-in path and why, when nothing is configured', async () => {
    const select = vi.fn(async () => selected)
    const recordFunctionModelEvent = vi.fn()
    const bridge = build({
      select,
      functionModels: {
        resolveFunctionModelTarget: vi.fn(async () => ({ resolution: resolution(null) })),
        recordFunctionModelEvent
      }
    })

    await expect(bridge('search pubmed', catalog)).resolves.toEqual(selected)
    expect(recordFunctionModelEvent).toHaveBeenCalledWith({
      functionId: 'skill-selection',
      outcome: 'built-in',
      reason: 'not-configured'
    })
  })

  it('names the reason when the configured model cannot be used', async () => {
    const select = vi.fn(async () => selected)
    const recordFunctionModelEvent = vi.fn()
    const bridge = build({
      select,
      functionModels: {
        resolveFunctionModelTarget: vi.fn(async () => ({
          resolution: resolution(null, ['provider-has-no-credentials'])
        })),
        recordFunctionModelEvent
      }
    })

    await bridge('search pubmed', catalog)

    expect(recordFunctionModelEvent).toHaveBeenCalledWith({
      functionId: 'skill-selection',
      outcome: 'built-in',
      reason: 'provider-has-no-credentials'
    })
    // The unusable override is not attempted: the fallback is the answer, not a retry.
    expect(select).toHaveBeenCalledTimes(1)
  })

  it('sends the narrow call to the configured model and records that it answered', async () => {
    const select = vi.fn(async () => selected)
    const recordFunctionModelEvent = vi.fn()
    const target = { baseUrl: 'https://configured.example/v1', key: 'k', model: 'small-model' }
    const bridge = build({
      select,
      functionModels: {
        resolveFunctionModelTarget: vi.fn(async () => ({
          resolution: resolution({ providerId: 'provider-a', model: 'small-model' }),
          target
        })),
        recordFunctionModelEvent
      }
    })

    await expect(bridge('search pubmed', catalog)).resolves.toEqual(selected)

    expect(select).toHaveBeenCalledWith('search pubmed', catalog, undefined, target)
    expect(recordFunctionModelEvent).toHaveBeenCalledWith({
      functionId: 'skill-selection',
      outcome: 'used-model',
      providerId: 'provider-a',
      model: 'small-model'
    })
  })

  it('falls back and records the failure when the configured model throws', async () => {
    const select = vi
      .fn()
      .mockRejectedValueOnce(new Error('unreachable'))
      .mockResolvedValueOnce(selected)
    const recordFunctionModelEvent = vi.fn()
    const bridge = build({
      select,
      functionModels: {
        resolveFunctionModelTarget: vi.fn(async () => ({
          resolution: resolution({ providerId: 'provider-a', model: 'small-model' }),
          target: { baseUrl: 'https://configured.example/v1', model: 'small-model' }
        })),
        recordFunctionModelEvent
      }
    })

    // The turn still gets its skills: a model that cannot be reached is a fallback, not a failure.
    await expect(bridge('search pubmed', catalog)).resolves.toEqual(selected)
    expect(recordFunctionModelEvent).toHaveBeenLastCalledWith({
      functionId: 'skill-selection',
      outcome: 'built-in',
      reason: 'call-failed',
      providerId: 'provider-a',
      model: 'small-model'
    })
    expect(select).toHaveBeenLastCalledWith('search pubmed', catalog, undefined)
  })
})
