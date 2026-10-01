// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const LABELS: Record<string, string> = {
  'settings.functionModelSkillSelection': 'Skill selection',
  'settings.functionModelSkillSelectionDetail': 'Picks the skills a turn loads',
  'settings.functionModelBuiltInPath': 'Built-in path (no model)',
  'settings.functionModelUsing': 'Using {model} from {provider}.',
  'settings.functionModelsFallbackSkillSelection':
    'No model configured: the whole catalog still reaches the agent.',
  'settings.functionModelUnusableProviderMissing': 'the service on record no longer exists.',
  'settings.functionModelUnusableNoCredentials': 'the service on record has no usable key.',
  'settings.functionModelUnusableUnverified': 'the service on record failed its last check.',
  'settings.functionModelUnusableModelMissing': 'that service no longer offers the model.',
  'settings.functionModelLoading': 'Reading…',
  'settings.functionModelUnavailable': 'Unavailable in this window.'
}

vi.mock('@/i18n', () => ({
  useLanguage: () => ({
    t: (key: string, vars?: Record<string, string>) => {
      let value = LABELS[key] ?? key
      for (const [name, replacement] of Object.entries(vars ?? {})) {
        value = value.replace(`{${name}}`, replacement)
      }

      return value
    }
  })
}))

import { useSettingsStore, createInitialSettingsState } from '@/stores/settings-store'

import { FunctionModelRow } from './FunctionModelSelect'

let container: HTMLDivElement
let root: Root

const fallback = {
  kind: 'built-in-deterministic' as const,
  detailKey: 'settings.functionModelsFallbackSkillSelection'
}

// The row reads through one channel; the test stands in for the main process behind it.
const stubApi = (resolved: unknown, models: unknown = {}): void => {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      settings: {
        functionModels: vi.fn().mockResolvedValue({ models, resolved })
      }
    }
  })
}

const render = async (): Promise<void> => {
  await act(async () => {
    root.render(<FunctionModelRow functionId="skill-selection" />)
    await new Promise((resolve) => window.setTimeout(resolve, 0))
  })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

describe('FunctionModelRow', () => {
  it('says which built-in path runs when nothing is configured', async () => {
    useSettingsStore.setState({ ...createInitialSettingsState(), providers: [] })
    stubApi({ functionId: 'skill-selection', override: null, fallback, unusable: [] })

    await render()

    expect(container.textContent).toContain('Skill selection')
    expect(container.textContent).toContain('Built-in path (no model)')
    // The fallback is a path the user can read, not an absence of one.
    expect(container.textContent).toContain(
      'No model configured: the whole catalog still reaches the agent.'
    )
  })

  it('names the model in force and the service it comes from', async () => {
    useSettingsStore.setState({
      ...createInitialSettingsState(),
      providers: [{ id: 'p1', name: 'Gateway', type: 'custom', models: ['small-model'] } as never]
    })
    stubApi(
      {
        functionId: 'skill-selection',
        override: { providerId: 'p1', model: 'small-model' },
        fallback,
        unusable: []
      },
      { 'skill-selection': { providerId: 'p1', model: 'small-model' } }
    )

    await render()

    expect(container.textContent).toContain('Using small-model from Gateway.')
    // With a usable override in force there is nothing to explain away.
    expect(
      container.querySelector('[data-testid="function-model-fallback-skill-selection"]')
    ).toBeNull()
  })

  it('names why an override on record is not being used', async () => {
    useSettingsStore.setState({ ...createInitialSettingsState(), providers: [] })
    stubApi(
      { functionId: 'skill-selection', override: null, fallback, unusable: ['provider-missing'] },
      { 'skill-selection': { providerId: 'gone', model: 'small-model' } }
    )

    await render()

    expect(
      container.querySelector('[data-testid="function-model-fallback-skill-selection"]')
        ?.textContent
    ).toContain('the service on record no longer exists.')
  })

  it('says the settings are unreadable here instead of showing an empty row', async () => {
    useSettingsStore.setState({ ...createInitialSettingsState(), providers: [] })
    Object.defineProperty(window, 'api', { configurable: true, value: {} })

    await render()

    expect(container.textContent).toContain('Unavailable in this window.')
  })
})
