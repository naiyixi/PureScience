// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const LABELS: Record<string, string> = {
  'settings.skillAvailability': 'Skill availability by reader',
  'settings.skillAvailabilityHint': 'Turn a skill off for one reader only.',
  'settings.skillAvailabilityTargetCodex': 'Codex sessions',
  'settings.skillAvailabilityWithheld': '{n} withheld',
  'settings.skillAvailabilityAlwaysOn': 'always on',
  'settings.skillAvailabilityGloballyOff': 'off globally',
  'settings.skillAvailabilityUnavailable': 'unavailable here'
}

vi.mock('@/i18n', () => ({
  useLanguage: () => ({
    t: (key: string) => LABELS[key] ?? key
  })
}))

import { SkillAvailabilityMatrix } from './SkillAvailabilityMatrix'

let container: HTMLDivElement
let root: Root

const view = {
  targets: [{ id: 'codex', skillIds: ['pdf-notes'] }],
  skills: [
    { id: 'pdf-notes', name: 'PDF notes', alwaysOn: false },
    { id: 'os-gatekeeper', name: 'Gatekeeper', alwaysOn: true },
    { id: 'figures', name: 'Figures', alwaysOn: false }
  ],
  globallyDisabledSkillIds: ['figures']
}

const stubApi = (): ReturnType<typeof vi.fn> => {
  const call = vi
    .fn()
    .mockImplementation(async (request: { action: string }) =>
      request.action === 'get' ? { view } : { view }
    )
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { settings: { skillAvailability: call } }
  })

  return call
}

const render = async (): Promise<void> => {
  await act(async () => {
    root.render(<SkillAvailabilityMatrix />)
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

describe('SkillAvailabilityMatrix', () => {
  it('shows a lock where a switch would do nothing', async () => {
    stubApi()
    await render()

    const gatekeeper = container.querySelector<HTMLInputElement>(
      '[data-testid="skill-availability-codex-os-gatekeeper"] input'
    )
    const globallyOff = container.querySelector<HTMLInputElement>(
      '[data-testid="skill-availability-codex-figures"] input'
    )
    // Both are unchangeable here, and the row says which kind of unchangeable it is.
    expect(gatekeeper?.disabled).toBe(true)
    expect(globallyOff?.disabled).toBe(true)
    expect(container.textContent).toContain('always on')
    expect(container.textContent).toContain('off globally')
  })

  it('withholds a skill from that reader only when the switch is used', async () => {
    const call = stubApi()
    await render()

    const notes = container.querySelector<HTMLInputElement>(
      '[data-testid="skill-availability-codex-pdf-notes"] input'
    )
    expect(notes?.checked).toBe(true)
    await act(async () => {
      notes?.click()
      await new Promise((resolve) => window.setTimeout(resolve, 0))
    })

    const setRequest = call.mock.calls.map(([request]) => request).find((r) => r.action === 'set')
    // The write names the reader and the exact set — not "some skills changed".
    expect(setRequest).toEqual({ action: 'set', targetId: 'codex', disabledSkillIds: [] })
  })
})
