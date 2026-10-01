import { describe, expect, it } from 'vitest'

import {
  FUNCTION_MODEL_FALLBACKS,
  FUNCTION_MODEL_IDS,
  isFunctionModelId,
  resolveFunctionModel,
  sanitizeFunctionModels
} from './function-models'

// Every slot names a real consumer. This case exists so a slot cannot be added for a feature nobody built
// without the test file changing too — which is the point at which someone has to justify it.
describe('function slots', () => {
  it('lists only functions with a consumer, and each has a stated built-in path', () => {
    expect(FUNCTION_MODEL_IDS).toEqual(['skill-selection'])
    for (const id of FUNCTION_MODEL_IDS) {
      expect(FUNCTION_MODEL_FALLBACKS[id].kind).toBe('built-in-deterministic')
      expect(FUNCTION_MODEL_FALLBACKS[id].detailKey.length).toBeGreaterThan(0)
    }
  })

  it('recognises its own ids and nothing else', () => {
    expect(isFunctionModelId('skill-selection')).toBe(true)
    expect(isFunctionModelId('literature-classification')).toBe(false)
  })
})

type ProviderFactsFixture = {
  id: string
  hasCredentials: boolean
  models?: readonly string[]
  validationFailed?: boolean
}

const provider = (overrides: Partial<ProviderFactsFixture> = {}): ProviderFactsFixture => ({
  id: 'provider-a',
  hasCredentials: true,
  ...overrides
})

describe('resolveFunctionModel', () => {
  it('says which built-in path runs when nothing is configured', () => {
    const resolution = resolveFunctionModel({ functionId: 'skill-selection', providers: [] })

    expect(resolution.override).toBeNull()
    expect(resolution.fallback).toEqual(FUNCTION_MODEL_FALLBACKS['skill-selection'])
    // Nobody configured this: an empty reason list, not a failure.
    expect(resolution.unusable).toEqual([])
  })

  it('uses a configured model when the provider can authenticate and offers it', () => {
    const resolution = resolveFunctionModel({
      functionId: 'skill-selection',
      stored: { 'skill-selection': { providerId: 'provider-a', model: 'small-model' } },
      providers: [provider({ models: ['small-model', 'large-model'] })]
    })

    expect(resolution.override).toEqual({ providerId: 'provider-a', model: 'small-model' })
    expect(resolution.unusable).toEqual([])
  })

  it('names a missing provider rather than quietly going without it', () => {
    const resolution = resolveFunctionModel({
      functionId: 'skill-selection',
      stored: { 'skill-selection': { providerId: 'gone', model: 'small-model' } },
      providers: [provider()]
    })

    expect(resolution.override).toBeNull()
    expect(resolution.unusable).toEqual(['provider-missing'])
  })

  it('names missing credentials ahead of the model question', () => {
    const resolution = resolveFunctionModel({
      functionId: 'skill-selection',
      stored: { 'skill-selection': { providerId: 'provider-a', model: 'small-model' } },
      providers: [provider({ hasCredentials: false, models: ['other-model'] })]
    })

    // Both are wrong; reporting the model would send the reader to fix the smaller problem first.
    expect(resolution.unusable).toEqual(['provider-has-no-credentials'])
  })

  it('refuses a provider whose last check failed, even though a key is stored', () => {
    const resolution = resolveFunctionModel({
      functionId: 'skill-selection',
      stored: { 'skill-selection': { providerId: 'provider-a', model: 'small-model' } },
      providers: [provider({ models: ['small-model'], validationFailed: true })]
    })

    expect(resolution.override).toBeNull()
    expect(resolution.unusable).toEqual(['provider-unverified'])
  })

  it('names a model the provider does not offer', () => {
    const resolution = resolveFunctionModel({
      functionId: 'skill-selection',
      stored: { 'skill-selection': { providerId: 'provider-a', model: 'not-offered' } },
      providers: [provider({ models: ['small-model'] })]
    })

    expect(resolution.unusable).toEqual(['model-missing'])
  })

  it('does not turn an unread model list into a failure', () => {
    const resolution = resolveFunctionModel({
      functionId: 'skill-selection',
      stored: { 'skill-selection': { providerId: 'provider-a', model: 'small-model' } },
      providers: [provider()]
    })

    // `models` undefined means the list was never read; an unread list is not evidence of absence.
    expect(resolution.override).toEqual({ providerId: 'provider-a', model: 'small-model' })
    expect(resolution.unusable).toEqual([])
  })
})

describe('sanitizeFunctionModels', () => {
  it('keeps known slots with their provider and model', () => {
    expect(
      sanitizeFunctionModels({
        'skill-selection': { providerId: ' provider-a ', model: ' small-model ' }
      })
    ).toEqual({ 'skill-selection': { providerId: 'provider-a', model: 'small-model' } })
  })

  it('drops a slot this build does not have instead of carrying it forward', () => {
    expect(
      sanitizeFunctionModels({
        'skill-selection': { providerId: 'provider-a', model: 'small-model' },
        'literature-classification': { providerId: 'provider-a', model: 'small-model' }
      })
    ).toEqual({ 'skill-selection': { providerId: 'provider-a', model: 'small-model' } })
  })

  it('treats an empty or broken map as nothing configured', () => {
    expect(sanitizeFunctionModels({})).toBeUndefined()
    expect(
      sanitizeFunctionModels({ 'skill-selection': { providerId: '', model: 'x' } })
    ).toBeUndefined()
    expect(sanitizeFunctionModels({ 'skill-selection': { providerId: 'p' } })).toBeUndefined()
    expect(sanitizeFunctionModels([])).toBeUndefined()
    expect(sanitizeFunctionModels('nope')).toBeUndefined()
  })
})
