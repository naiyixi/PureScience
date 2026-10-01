// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SkillDetailView } from './SkillDetailView'
import { createInitialSettingsState, useSettingsStore } from '@/stores/settings-store'

let container: HTMLDivElement
let root: Root

const detail = {
  id: 'a',
  name: 'Alpha',
  description: 'First skill description.',
  source: 'featured' as const,
  updatedAt: '2026-07-08T00:00:00.000Z',
  enabled: true,
  author: 'Test Author',
  license: 'Test License',
  thirdParty: 'Weights — Example (CC-BY-4.0)',
  body: '# Alpha body'
}

beforeEach(() => {
  ;(window as unknown as { api: unknown }).api = {
    settings: { getSkillDetail: vi.fn().mockResolvedValue(detail) }
  }
  useSettingsStore.setState({
    ...createInitialSettingsState(),
    skills: [
      {
        id: 'a',
        name: 'Alpha',
        description: 'First skill description.',
        source: 'featured',
        updatedAt: '2026-07-08T00:00:00.000Z',
        enabled: true
      }
    ],
    setSkillEnabled: vi.fn().mockResolvedValue(undefined)
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  delete (window as unknown as { api?: unknown }).api
})

describe('SkillDetailView', () => {
  it('shows the locally computed trigger quality and names the failing check', async () => {
    ;(window as unknown as { api: unknown }).api = {
      settings: {
        getSkillDetail: vi.fn().mockResolvedValue({
          ...detail,
          triggerQuality: {
            score: 6,
            checks: [
              { id: 'length', passed: true, message: 'ok' },
              { id: 'keyword_density', passed: false, message: 'no substantive keyword' }
            ],
            suggestions: []
          }
        })
      }
    }
    await act(async () => {
      root.render(<SkillDetailView skillId="a" />)
    })
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0))
    })

    // The suite's i18n fallback returns the key with placeholders intact, so the assertion is on the row's
    // presence and its difference from a passing row — the numbers are covered by the main-side case where
    // the score is compared against the pure scorer itself.
    expect(container.querySelector('[data-testid="skill-trigger-quality-score"]')).toBeTruthy()
    const failing = container.querySelector(
      '[data-testid="skill-trigger-check-keyword_density"]'
    )?.textContent
    const passing = container.querySelector(
      '[data-testid="skill-trigger-check-length"]'
    )?.textContent
    // The failing row says what is missing; it must not read like the passing one.
    expect(failing).toBeTruthy()
    expect(failing).not.toEqual(passing)
  })

  it('renders the header, Files body, and Details metadata from the frontmatter', async () => {
    await act(async () => {
      root.render(<SkillDetailView skillId="a" />)
    })
    // Let the getSkillDetail promise resolve and re-render with the body + metadata.
    await act(async () => {
      await Promise.resolve()
    })

    // Header: name + description below it.
    expect(document.body.textContent).toContain('Alpha')
    expect(document.body.textContent).toContain('First skill description.')

    // Files section renders the SKILL.md body.
    expect(document.body.textContent).toContain('Files')
    expect(document.body.textContent).toContain('Alpha body')

    // Details section surfaces frontmatter author + license + third-party info.
    expect(document.body.textContent).toContain('Details')
    expect(document.body.textContent).toContain('Author')
    expect(document.body.textContent).toContain('Test Author')
    expect(document.body.textContent).toContain('License')
    expect(document.body.textContent).toContain('Test License')
    expect(document.body.textContent).toContain(
      'Third-party software, content, terms, and information'
    )
    expect(document.body.textContent).toContain('Weights — Example (CC-BY-4.0)')
  })

  it('renders generic persisted metadata without duplicating dedicated detail rows', async () => {
    ;(window as unknown as { api: unknown }).api = {
      settings: {
        getSkillDetail: vi.fn().mockResolvedValue({
          ...detail,
          metadata: {
            author: 'Duplicate author',
            license: 'Duplicate license',
            'third-party': 'Duplicate third-party notice',
            category: 'Biology',
            custom_key: 'Custom value'
          }
        })
      }
    }

    await act(async () => {
      root.render(<SkillDetailView skillId="a" />)
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(document.body.textContent).toContain('Category')
    expect(document.body.textContent).toContain('Biology')
    expect(document.body.textContent).toContain('Custom Key')
    expect(document.body.textContent).toContain('Custom value')
    expect(document.body.textContent).not.toContain('Duplicate author')
    expect(document.body.textContent).not.toContain('Duplicate license')
    expect(document.body.textContent).not.toContain('Duplicate third-party notice')
  })

  it('labels the badge by the skill source, not always "Featured"', async () => {
    for (const [source, label] of [
      ['featured', 'Featured'],
      ['imported', 'Imported'],
      ['personal', 'Personal']
    ] as const) {
      ;(window as unknown as { api: unknown }).api = {
        settings: { getSkillDetail: vi.fn().mockResolvedValue({ ...detail, source }) }
      }
      useSettingsStore.setState({
        ...createInitialSettingsState(),
        skills: [
          {
            id: 'a',
            name: 'Alpha',
            description: 'First skill description.',
            source,
            updatedAt: detail.updatedAt,
            enabled: true
          }
        ],
        setSkillEnabled: vi.fn().mockResolvedValue(undefined)
      })

      const localContainer = document.createElement('div')
      document.body.appendChild(localContainer)
      const localRoot = createRoot(localContainer)
      await act(async () => {
        localRoot.render(<SkillDetailView skillId="a" />)
      })
      await act(async () => {
        await Promise.resolve()
      })

      const badge = localContainer.querySelector('span.rounded-full')
      expect(badge?.textContent).toBe(label)

      act(() => localRoot.unmount())
      localContainer.remove()
    }
  })

  it('offers no switch for a gatekeeper skill and states the policy instead', async () => {
    await act(async () => {
      root.render(<SkillDetailView skillId="a" />)
    })

    const toggle = document.body.querySelector<HTMLButtonElement>('[role="switch"]')
    expect(toggle?.disabled).toBe(true)
    act(() => toggle?.click())

    expect(useSettingsStore.getState().setSkillEnabled).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Ships with the app and always stays on.')
  })

  it('toggles a personal skill from the detail header switch', async () => {
    ;(window as unknown as { api: unknown }).api = {
      settings: {
        getSkillDetail: vi.fn().mockResolvedValue({ ...detail, source: 'personal' })
      }
    }
    useSettingsStore.setState({
      ...createInitialSettingsState(),
      skills: [
        {
          id: 'a',
          name: 'Alpha',
          description: 'First skill description.',
          source: 'personal',
          updatedAt: '2026-07-08T00:00:00.000Z',
          enabled: true
        }
      ],
      setSkillEnabled: vi.fn().mockResolvedValue(undefined)
    })
    await act(async () => {
      root.render(<SkillDetailView skillId="a" />)
    })

    const toggle = document.body.querySelector<HTMLButtonElement>('[role="switch"]')
    expect(toggle?.disabled).toBe(false)
    act(() => toggle?.click())

    expect(useSettingsStore.getState().setSkillEnabled).toHaveBeenCalledWith('a', false)
  })
})
