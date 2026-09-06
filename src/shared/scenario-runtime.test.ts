import { describe, expect, it } from 'vitest'

import type { ProviderView } from './settings'
import { resolveScenarioBackend } from './scenario-runtime'

const provider = (id: string): ProviderView =>
  ({
    id,
    name: id,
    type: 'vendor',
    vendorId: 'deepseek',
    baseUrl: 'https://api.deepseek.com/anthropic',
    model: 'deepseek-v4-flash',
    models: ['deepseek-v4-flash', 'deepseek-v4-pro'],
    supportsImageInput: false
  }) as unknown as ProviderView

const providers = [provider('deepseek')]

describe('resolveScenarioBackend', () => {
  it('inherits the active backend and the global effort when no override exists', () => {
    expect(
      resolveScenarioBackend({
        scenario: 'review',
        providers,
        activeProviderId: 'deepseek',
        activeModel: 'deepseek-v4-flash',
        globalReasoningEffort: 'high'
      })
    ).toEqual({
      providerId: 'deepseek',
      model: 'deepseek-v4-flash',
      reasoningEffort: 'high'
    })
  })

  it('returns null when there is no active backend to inherit', () => {
    expect(
      resolveScenarioBackend({
        scenario: 'review',
        providers,
        activeModel: 'deepseek-v4-flash',
        globalReasoningEffort: 'default'
      })
    ).toBeNull()
  })

  it('applies a pinned scenario model while keeping the global effort when effort is default', () => {
    expect(
      resolveScenarioBackend({
        scenario: 'review',
        scenarioModels: {
          review: {
            providerId: 'deepseek',
            model: 'deepseek-v4-pro',
            reasoningEffort: 'default'
          }
        },
        providers,
        activeProviderId: 'deepseek',
        activeModel: 'deepseek-v4-flash',
        globalReasoningEffort: 'medium'
      })
    ).toEqual({
      providerId: 'deepseek',
      model: 'deepseek-v4-pro',
      reasoningEffort: 'medium'
    })
  })

  it('pins effort independently when the scenario override carries a concrete level', () => {
    expect(
      resolveScenarioBackend({
        scenario: 'subagent',
        scenarioModels: {
          subagent: {
            providerId: 'deepseek',
            model: 'deepseek-v4-flash',
            reasoningEffort: 'max'
          }
        },
        providers,
        activeProviderId: 'deepseek',
        activeModel: 'deepseek-v4-flash',
        globalReasoningEffort: 'low'
      })
    ).toEqual({
      providerId: 'deepseek',
      model: 'deepseek-v4-flash',
      reasoningEffort: 'max'
    })
  })

  it('refuses a stored override whose provider no longer exists', () => {
    expect(
      resolveScenarioBackend({
        scenario: 'review',
        scenarioModels: {
          review: { providerId: 'gone', model: 'x', reasoningEffort: 'high' }
        },
        providers,
        activeProviderId: 'deepseek',
        activeModel: 'deepseek-v4-flash',
        globalReasoningEffort: 'medium'
      })
    ).toBeNull()
  })

  it('does not let one scenario leak its pinned effort into another', () => {
    const review = resolveScenarioBackend({
      scenario: 'review',
      scenarioModels: {
        review: { providerId: 'deepseek', model: 'deepseek-v4-pro', reasoningEffort: 'xhigh' }
      },
      providers,
      activeProviderId: 'deepseek',
      activeModel: 'deepseek-v4-flash',
      globalReasoningEffort: 'low'
    })
    const detail = resolveScenarioBackend({
      scenario: 'session-detail',
      scenarioModels: {
        review: { providerId: 'deepseek', model: 'deepseek-v4-pro', reasoningEffort: 'xhigh' }
      },
      providers,
      activeProviderId: 'deepseek',
      activeModel: 'deepseek-v4-flash',
      globalReasoningEffort: 'low'
    })
    expect(review?.reasoningEffort).toBe('xhigh')
    expect(detail).toEqual({
      providerId: 'deepseek',
      model: 'deepseek-v4-flash',
      reasoningEffort: 'low'
    })
  })
})
