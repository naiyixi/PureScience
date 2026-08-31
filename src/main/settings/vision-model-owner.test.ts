import { describe, expect, it, vi } from 'vitest'

import type { ProviderAccountsModule } from './provider-accounts'
import type { SettingsRepository } from './repository'
import { VisionModelOwner } from './vision-model-owner'

const sha256 = async (value: string): Promise<string> => {
  const { createHash } = await import('node:crypto')
  return createHash('sha256').update(value).digest('hex')
}

// A provider that supports image input and is framework-compatible.
const makeProvider = (
  overrides: Record<string, unknown> = {}
): ReturnType<typeof makeProviderInner> => makeProviderInner(overrides)

function makeProviderInner(
  overrides: Record<string, unknown> = {}
): {
  id: string
  type: string
  name: string
  baseUrl: string
  model: string
  supportsImageInput: boolean
  lastValidatedAt: number
  [key: string]: unknown
} {
  return {
    id: 'vision-provider',
    type: 'custom',
    name: 'Vision Provider',
    baseUrl: 'https://vision.example.com/v1',
    model: 'vision-model',
    supportsImageInput: true,
    lastValidatedAt: Date.now(),
    ...overrides
  }
}

const makeRuntimeTarget = (
  overrides: Record<string, unknown> = {}
): ReturnType<typeof makeRuntimeTargetInner> => makeRuntimeTargetInner(overrides)

function makeRuntimeTargetInner(
  overrides: Record<string, unknown> = {}
): {
  providerId: string
  providerType: string
  effectiveModel: string
  apiEndpoints: string[]
  provider: { supportsImageInput: boolean }
  reasoningEffortProfile: { supported: boolean }
  frameworkCompatible: boolean
  modelBridgeSupported: boolean
  [key: string]: unknown
} {
  return {
    providerId: 'vision-provider',
    providerType: 'custom',
    effectiveModel: 'vision-model',
    apiEndpoints: ['openai'],
    provider: { supportsImageInput: true },
    reasoningEffortProfile: { supported: true },
    frameworkCompatible: true,
    modelBridgeSupported: true,
    ...overrides
  }
}

const makeSettings = (
  overrides: Record<string, unknown> = {}
): ReturnType<typeof makeSettingsInner> => makeSettingsInner(overrides)

function makeSettingsInner(
  overrides: Record<string, unknown> = {}
): {
  version: number
  providers: ReturnType<typeof makeProvider>[]
  [key: string]: unknown
} {
  return {
    version: 1,
    providers: [makeProvider()],
    ...overrides
  }
}

const createOwner = (
  overrides: {
    repository?: Partial<Record<keyof SettingsRepository, unknown>>
    providers?: Partial<Record<keyof ProviderAccountsModule, unknown>>
    backendResolver?: Record<string, unknown>
  } = {}
): ReturnType<typeof createOwnerInner> => createOwnerInner(overrides)

function createOwnerInner(
  overrides: {
    repository?: Partial<Record<keyof SettingsRepository, unknown>>
    providers?: Partial<Record<keyof ProviderAccountsModule, unknown>>
    backendResolver?: Record<string, unknown>
  } = {}
): {
  owner: VisionModelOwner
  repository: SettingsRepository
  providers: ProviderAccountsModule
  backendResolver: { captureConfiguredSelection: ReturnType<typeof vi.fn> }
} {
  const repository = {
    getSettings: vi.fn(async () => makeSettings()),
    setVisionModel: vi.fn(async () => makeSettings()),
    ...overrides.repository
  } as unknown as SettingsRepository
  const providers = {
    resolveRuntimeTarget: vi.fn(() => makeRuntimeTarget()),
    ...overrides.providers
  } as unknown as ProviderAccountsModule
  const backendResolver = {
    captureConfiguredSelection: vi.fn(async () => ({ frameworkId: 'claude-code' })),
    ...overrides.backendResolver
  }
  const owner = new VisionModelOwner({
    repository,
    providers,
    backendResolver
  } as never)
  return { owner, repository, providers, backendResolver }
}

describe('VisionModelOwner.set', () => {
  it('persists undefined to disable the relay', async () => {
    const { owner, repository } = createOwner()
    await owner.set(undefined)
    expect(repository.setVisionModel).toHaveBeenCalledWith(undefined)
    expect(repository.setVisionModel).toHaveBeenCalledTimes(1)
  })

  it('persists a valid configuration', async () => {
    const { owner, repository, providers } = createOwner()
    const configuration = {
      providerId: 'vision-provider',
      model: 'vision-model',
      reasoningEffort: 'high' as const
    }
    await owner.set(configuration)
    expect(providers.resolveRuntimeTarget).toHaveBeenCalled()
    expect(repository.setVisionModel).toHaveBeenCalledWith(configuration)
  })

  it('rejects a configuration whose provider does not exist', async () => {
    const { owner, repository } = createOwner()
    await expect(
      owner.set({ providerId: 'missing', model: 'm', reasoningEffort: 'default' })
    ).rejects.toThrow(/no longer available/)
    expect(repository.setVisionModel).not.toHaveBeenCalled()
  })

  it('rejects a provider whose latest validation failed', async () => {
    const { owner, repository } = createOwner({
      repository: {
        getSettings: vi.fn(async () =>
          makeSettings({
            providers: [
              makeProvider({
                lastValidationFailure: { at: Date.now(), message: 'bad key' },
                lastValidatedAt: 0
              })
            ]
          })
        ),
        setVisionModel: vi.fn(async () => makeSettings())
      }
    })
    await expect(
      owner.set({ providerId: 'vision-provider', model: 'm', reasoningEffort: 'default' })
    ).rejects.toThrow(/no longer available/)
    expect(repository.setVisionModel).not.toHaveBeenCalled()
  })

  it('rejects Codex subscription providers', async () => {
    const { owner, repository } = createOwner({
      repository: {
        getSettings: vi.fn(async () =>
          makeSettings({
            providers: [makeProvider({ type: 'codex-shared' })]
          })
        ),
        setVisionModel: vi.fn(async () => makeSettings())
      }
    })
    await expect(
      owner.set({ providerId: 'vision-provider', model: 'm', reasoningEffort: 'default' })
    ).rejects.toThrow(/Codex subscription/)
    expect(repository.setVisionModel).not.toHaveBeenCalled()
  })

  it('rejects a model that does not support image input', async () => {
    const { owner, repository, providers } = createOwner()
    providers.resolveRuntimeTarget = vi.fn(() =>
      makeRuntimeTarget({ provider: { supportsImageInput: false } })
    ) as never
    await expect(
      owner.set({ providerId: 'vision-provider', model: 'm', reasoningEffort: 'default' })
    ).rejects.toThrow(/does not support image input/)
    expect(repository.setVisionModel).not.toHaveBeenCalled()
  })

  it('rejects a target that is not framework-compatible', async () => {
    const { owner, repository, providers } = createOwner()
    providers.resolveRuntimeTarget = vi.fn(() =>
      makeRuntimeTarget({ frameworkCompatible: false })
    ) as never
    await expect(
      owner.set({ providerId: 'vision-provider', model: 'm', reasoningEffort: 'default' })
    ).rejects.toThrow(/not available for the active Agent Framework/)
    expect(repository.setVisionModel).not.toHaveBeenCalled()
  })
})

describe('VisionModelOwner.admit', () => {
  it('returns undefined when no Vision model is configured', async () => {
    const { owner } = createOwner({
      repository: {
        getSettings: vi.fn(async () => makeSettings({ visionModel: undefined })),
        setVisionModel: vi.fn(async () => makeSettings())
      }
    })
    await expect(owner.admit()).resolves.toBeUndefined()
  })

  it('resolves a persisted configuration into an explicit target', async () => {
    const { owner, backendResolver } = createOwner({
      repository: {
        getSettings: vi.fn(async () =>
          makeSettings({
            visionModel: {
              providerId: 'vision-provider',
              model: 'vision-model',
              reasoningEffort: 'high'
            }
          })
        ),
        setVisionModel: vi.fn(async () => makeSettings())
      }
    })
    const target = await owner.admit()
    expect(target).toEqual({
      frameworkId: 'claude-code',
      providerId: 'vision-provider',
      model: { kind: 'required', id: 'vision-model' },
      reasoningEffort: 'high'
    })
    expect(backendResolver.captureConfiguredSelection).toHaveBeenCalled()
  })

  it('throws when the configured provider is missing', async () => {
    const { owner } = createOwner({
      repository: {
        getSettings: vi.fn(async () =>
          makeSettings({
            providers: [],
            visionModel: { providerId: 'gone', model: 'm', reasoningEffort: 'default' }
          })
        ),
        setVisionModel: vi.fn(async () => makeSettings())
      }
    })
    await expect(owner.admit()).rejects.toThrow(/provider is unavailable/)
  })

  it('throws when the resolved target cannot accept images', async () => {
    const { owner, providers } = createOwner({
      repository: {
        getSettings: vi.fn(async () =>
          makeSettings({
            visionModel: {
              providerId: 'vision-provider',
              model: 'vision-model',
              reasoningEffort: 'default'
            }
          })
        ),
        setVisionModel: vi.fn(async () => makeSettings())
      }
    })
    providers.resolveRuntimeTarget = vi.fn(() =>
      makeRuntimeTarget({ provider: { supportsImageInput: false } })
    ) as never
    await expect(owner.admit()).rejects.toThrow(/unavailable for image input/)
  })
})

// Keep the sha256 helper referenced so tree-shaking never flags it in coverage runs.
void sha256
