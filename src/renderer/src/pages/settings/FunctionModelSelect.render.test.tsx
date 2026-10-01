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
  'settings.functionModelUnavailable': 'Unavailable in this window.',
  'settings.functionModelDetect': 'Detect',
  'settings.functionModelDetecting': 'Calling the model…',
  'settings.functionModelDetectNote': 'Detection sends one real request.',
  'settings.functionModelDetectNeedsModel': 'Choose a model first.',
  'settings.functionModelDetected': 'Answered in {ms} ms; {usage}.',
  'settings.functionModelDetectedUsage': '{input} in / {output} out',
  'settings.functionModelDetectedNoUsage': 'usage not reported',
  'settings.functionModelDetectFailed': 'Detection failed:',
  'settings.functionModelTrail': 'Recent function calls',
  'settings.functionModelTrailHint': 'What the calls did',
  'settings.functionModelTrailRefresh': 'Refresh',
  'settings.functionModelTrailEmpty': 'Nothing recorded yet.',
  'settings.functionModelTrailUsed': 'used {model} from {provider}',
  'settings.functionModelTrailBuiltIn': 'built-in path:',
  'settings.functionModelTrailCallFailed': 'the call failed',
  'settings.functionModelDetectReasonUnreachable': 'the endpoint could not be reached',
  'settings.functionModelDetectReasonNotConfigured': 'no model is configured for this function',
  'settings.functionModelProbeRun': 'Run one selection now',
  'settings.functionModelProbing': 'Running…',
  'settings.functionModelProbeNote': 'Runs the same narrow call a turn makes.',
  'settings.functionModelProbeUsedModel': '{model} answered in {ms} ms and selected {n} skill(s).',
  'settings.functionModelProbeBuiltIn': 'Built-in path ran in {ms} ms —',
  'settings.functionModelNotAttempted': 'no request was sent: nothing to select for'
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

import { FunctionModelRow, FunctionModelTrail } from './FunctionModelSelect'

let container: HTMLDivElement
let root: Root

const fallback = {
  kind: 'built-in-deterministic' as const,
  detailKey: 'settings.functionModelsFallbackSkillSelection'
}

// The row reads through one channel; the test stands in for the main process behind it.
const stubApi = (
  resolved: unknown,
  models: unknown = {},
  detected?: unknown,
  probe?: unknown
): void => {
  const call = vi.fn().mockImplementation(async (request: { action: string }) => {
    if (request.action === 'detect') return { models, detected }
    if (request.action === 'probe') return { models, probe }

    return { models, resolved }
  })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { settings: { functionModels: call } }
  })
}

const click = async (testId: string): Promise<void> => {
  const button = container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)
  await act(async () => {
    button?.click()
    await new Promise((resolve) => window.setTimeout(resolve, 0))
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
  it('runs one selection on demand and leaves the control usable with no model configured', async () => {
    // No model configured: the built-in path is what a turn would take, and naming that IS the answer to
    // "is my model being used" — so the control must not disappear behind a disabled state.
    useSettingsStore.setState({ ...createInitialSettingsState(), providers: [] })
    stubApi(
      { functionId: 'skill-selection', override: null, fallback, unusable: [] },
      {},
      undefined,
      {
        outcome: 'built-in',
        reason: 'not-configured',
        elapsedMs: 3,
        selectedSkillIds: []
      }
    )

    await render()
    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="function-model-run-probe-skill-selection"]'
    )
    expect(button?.disabled).toBe(false)

    await click('function-model-run-probe-skill-selection')

    const line = container.querySelector(
      '[data-testid="function-model-probe-skill-selection"]'
    )?.textContent
    expect(line).toContain('Built-in path ran in 3 ms')
    expect(line).toContain('no model is configured for this function')
  })

  it('says no request was sent instead of reporting a model that never ran', async () => {
    // The bridge returns an empty list both when a model answers "nothing" and when it was never asked, so
    // the probe refuses to guess: this reason exists so "used-model" cannot be claimed for a call that never
    // left the machine.
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
      { 'skill-selection': { providerId: 'p1', model: 'small-model' } },
      undefined,
      {
        outcome: 'built-in',
        reason: 'call-not-attempted',
        providerId: 'p1',
        model: 'small-model',
        elapsedMs: 1,
        selectedSkillIds: []
      }
    )

    await render()
    await click('function-model-run-probe-skill-selection')

    const line = container.querySelector(
      '[data-testid="function-model-probe-skill-selection"]'
    )?.textContent
    expect(line).toContain('Built-in path ran in 1 ms')
    expect(line).toContain('no request was sent')
  })

  it('reports the model that answered and what it selected', async () => {
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
      { 'skill-selection': { providerId: 'p1', model: 'small-model' } },
      undefined,
      {
        outcome: 'used-model',
        providerId: 'p1',
        model: 'small-model',
        elapsedMs: 147,
        selectedSkillIds: ['alpha', 'beta']
      }
    )

    await render()
    await click('function-model-run-probe-skill-selection')

    const line = container.querySelector(
      '[data-testid="function-model-probe-skill-selection"]'
    )?.textContent
    expect(line).toContain('small-model answered in 147 ms')
    expect(line).toContain('2 skill(s)')
  })

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

  it('offers detection only once there is a model to detect', async () => {
    useSettingsStore.setState({ ...createInitialSettingsState(), providers: [] })
    stubApi({ functionId: 'skill-selection', override: null, fallback, unusable: [] })

    await render()

    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="function-model-detect-skill-selection"]'
    )
    // Probing the built-in path would be a measurement of nothing.
    expect(button?.disabled).toBe(true)
    expect(container.textContent).toContain('Choose a model first.')
  })

  it('shows what a detection measured, not just that it passed', async () => {
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
      { 'skill-selection': { providerId: 'p1', model: 'small-model' } },
      {
        ok: true,
        elapsedMs: 42,
        providerId: 'p1',
        model: 'small-model',
        usage: { inputTokens: 3, outputTokens: 2 }
      }
    )

    await render()
    await click('function-model-detect-skill-selection')

    const line = container.querySelector('[data-testid="function-model-detection-skill-selection"]')
    expect(line?.textContent).toContain('42')
    // The token counts are the point of measuring: a tick alone would be a claim about a call nobody saw.
    expect(line?.textContent).toContain('3 in / 2 out')
  })

  it('names why a detection failed', async () => {
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
      { 'skill-selection': { providerId: 'p1', model: 'small-model' } },
      { ok: false, elapsedMs: 12, reason: 'unreachable', providerId: 'p1', model: 'small-model' }
    )

    await render()
    await click('function-model-detect-skill-selection')

    expect(
      container.querySelector('[data-testid="function-model-detection-skill-selection"]')
        ?.textContent
    ).toContain('the endpoint could not be reached')
  })

  it('says the settings are unreadable here instead of showing an empty row', async () => {
    useSettingsStore.setState({ ...createInitialSettingsState(), providers: [] })
    Object.defineProperty(window, 'api', { configurable: true, value: {} })

    await render()

    expect(container.textContent).toContain('Unavailable in this window.')
  })
})

describe('FunctionModelTrail', () => {
  const stubEvents = (events: unknown[]): void => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        settings: {
          functionModels: vi.fn().mockResolvedValue({ models: {}, events })
        }
      }
    })
  }

  const renderTrail = async (): Promise<void> => {
    await act(async () => {
      root.render(<FunctionModelTrail />)
      await new Promise((resolve) => window.setTimeout(resolve, 0))
    })
  }

  it('says nothing has been recorded yet rather than showing an empty box', async () => {
    useSettingsStore.setState({ ...createInitialSettingsState(), providers: [] })
    stubEvents([])

    await renderTrail()

    expect(
      container.querySelector('[data-testid="function-model-trail-empty"]')?.textContent
    ).toContain('Nothing recorded yet.')
  })

  it('shows what each call did, newest first, naming the model or the reason', async () => {
    useSettingsStore.setState({
      ...createInitialSettingsState(),
      providers: [{ id: 'p1', name: 'Gateway', type: 'custom', models: ['small-model'] } as never]
    })
    stubEvents([
      { at: 1, functionId: 'skill-selection', outcome: 'built-in', reason: 'not-configured' },
      {
        at: 2,
        functionId: 'skill-selection',
        outcome: 'used-model',
        providerId: 'p1',
        model: 'small-model'
      }
    ])

    await renderTrail()

    const entries = [...container.querySelectorAll('[data-testid="function-model-trail-entry"]')]
    expect(entries).toHaveLength(2)
    // Newest first: the answer to "why did this run do that" is about the most recent run.
    expect(entries[0].textContent).toContain('used small-model from Gateway')
    expect(entries[1].textContent).toContain('built-in path:')
    expect(entries[1].textContent).toContain('no model is configured for this function')
  })
})
