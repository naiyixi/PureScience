// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SkillDetailView } from './SkillDetailView'
import { createInitialSettingsState, useSettingsStore } from '@/stores/settings-store'

let container: HTMLDivElement
let root: Root
// The fork action hands the copy's id back to whoever opened the detail view; a spy is required on every
// render because the prop is required (a detail view nobody can navigate away from is not offered a fork).
const onForked = vi.fn()

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
  onForked.mockClear()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  delete (window as unknown as { api?: unknown }).api
})

describe('SkillDetailView', () => {
  it('says an imported skill no longer matches what was imported', async () => {
    ;(window as unknown as { api: unknown }).api = {
      settings: {
        getSkillDetail: vi.fn().mockResolvedValue({
          ...detail,
          source: 'imported',
          integrity: 'changed'
        })
      }
    }

    await act(async () => {
      root.render(<SkillDetailView skillId="a" onForked={onForked} />)
    })
    await act(async () => {
      await Promise.resolve()
    })

    const row = document.body.querySelector('[data-testid="skill-content-integrity"]')
    expect(row?.getAttribute('data-integrity')).toBe('changed')
    // …and the same view says what an imported skill is NOT: it stays the imported copy, and duplicating it
    // is the way to get one of your own.
    expect(document.body.querySelector('[data-slot="skill-imported-kept"]')?.textContent).toBe(
      'Kept as imported: this copy is compared against what you imported. Duplicate it to get a skill of your own that you can edit.'
    )
    // The copy entry is offered here and is reachable (not a disabled stub): the sentence above promises it.
    const forkButton = document.body.querySelector<HTMLButtonElement>('[data-slot="skill-fork"]')
    expect(forkButton?.disabled).toBe(false)
    expect(row?.textContent).toContain('Content differs from what was imported.')
  })

  it('gives a curated skill no integrity state at all', async () => {
    // Nothing to compare a bundled skill against, so it gets no row rather than a meaningless state.
    ;(window as unknown as { api: unknown }).api = {
      settings: {
        getSkillDetail: vi.fn().mockResolvedValue({ ...detail, source: 'featured' })
      }
    }
    await act(async () => {
      root.render(<SkillDetailView skillId="a" onForked={onForked} />)
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(document.body.querySelector('[data-testid="skill-content-integrity"]')).toBeNull()
    // A curated skill is not an imported one, so neither the "kept as imported" line nor the fork entry
    // appears for it: there is nothing to keep as imported and nothing to fork.
    expect(document.body.querySelector('[data-slot="skill-imported-kept"]')).toBeNull()
    expect(document.body.querySelector('[data-slot="skill-fork"]')).toBeNull()
  })

  it('says the licence is unknown instead of leaving the row blank', async () => {
    ;(window as unknown as { api: unknown }).api = {
      settings: {
        getSkillDetail: vi.fn().mockResolvedValue({
          ...detail,
          license: undefined,
          licenseStatus: 'needs-review'
        })
      }
    }
    await act(async () => {
      root.render(<SkillDetailView skillId="a" onForked={onForked} />)
    })
    await act(async () => {
      await Promise.resolve()
    })

    // A blank where a licence should be reads as "nothing to worry about", which is the opposite of the truth.
    expect(document.body.textContent).toContain('Unknown')
    expect(
      document.body.querySelector('[data-testid="skill-license-status"]')?.textContent
    ).toContain('ask before commercial use')
  })

  it('keeps quiet when the licence is a recognised permissive one', async () => {
    ;(window as unknown as { api: unknown }).api = {
      settings: {
        getSkillDetail: vi.fn().mockResolvedValue({
          ...detail,
          license: 'MIT',
          licenseStatus: 'allowed'
        })
      }
    }
    await act(async () => {
      root.render(<SkillDetailView skillId="a" onForked={onForked} />)
    })
    await act(async () => {
      await Promise.resolve()
    })

    // Nothing to warn about: a permanent caution on every permissive skill would train the reader to ignore it.
    expect(document.body.querySelector('[data-testid="skill-license-status"]')).toBeNull()
  })

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
      root.render(<SkillDetailView skillId="a" onForked={onForked} />)
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
      root.render(<SkillDetailView skillId="a" onForked={onForked} />)
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
      root.render(<SkillDetailView skillId="a" onForked={onForked} />)
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
        localRoot.render(<SkillDetailView skillId="a" onForked={onForked} />)
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
      root.render(<SkillDetailView skillId="a" onForked={onForked} />)
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
      root.render(<SkillDetailView skillId="a" onForked={onForked} />)
    })

    const toggle = document.body.querySelector<HTMLButtonElement>('[role="switch"]')
    expect(toggle?.disabled).toBe(false)
    act(() => toggle?.click())

    expect(useSettingsStore.getState().setSkillEnabled).toHaveBeenCalledWith('a', false)
  })

  it('duplicates an imported skill into one of my own and opens the copy', async () => {
    const copied = {
      id: 'personal-alpha-copy',
      name: 'Alpha',
      description: 'First skill description.',
      source: 'personal' as const,
      updatedAt: '2026-07-08T00:00:00.000Z',
      enabled: true
    }
    const forkImportedSkill = vi.fn().mockResolvedValue({ id: copied.id, skills: [copied] })
    ;(window as unknown as { api: unknown }).api = {
      settings: {
        getSkillDetail: vi.fn().mockResolvedValue({ ...detail, source: 'imported' }),
        forkImportedSkill
      }
    }
    await act(async () => {
      root.render(<SkillDetailView skillId="a" onForked={onForked} />)
    })
    await act(async () => {
      await Promise.resolve()
    })

    const button = document.body.querySelector<HTMLButtonElement>('[data-slot="skill-fork"]')
    expect(button).not.toBeNull()
    await act(async () => {
      button?.click()
      await new Promise((resolve) => window.setTimeout(resolve, 0))
    })

    // The id is asked for by the id the view already shows, and the copy the store now holds is the one
    // main reported — nothing here re-derives a slug of its own.
    expect(forkImportedSkill).toHaveBeenCalledWith({ id: 'a' })
    expect(useSettingsStore.getState().skills.map((skill) => skill.id)).toEqual([copied.id])
    expect(onForked).toHaveBeenCalledWith(copied.id)
    expect(document.body.querySelector('[data-slot="skill-fork-error"]')).toBeNull()
  })

  it('reports a failed fork in place and does not open anything', async () => {
    ;(window as unknown as { api: unknown }).api = {
      settings: {
        getSkillDetail: vi.fn().mockResolvedValue({ ...detail, source: 'imported' }),
        forkImportedSkill: vi.fn().mockRejectedValue(new Error('Not an imported skill id: a'))
      }
    }
    await act(async () => {
      root.render(<SkillDetailView skillId="a" onForked={onForked} />)
    })
    await act(async () => {
      await Promise.resolve()
    })

    await act(async () => {
      document.body.querySelector<HTMLButtonElement>('[data-slot="skill-fork"]')?.click()
      await new Promise((resolve) => window.setTimeout(resolve, 0))
    })

    // Navigating to an editor for a copy that was never created would look exactly like success, so the
    // failure has to be visible here and the reader has to stay put.
    const failure = document.body.querySelector('[data-slot="skill-fork-error"]')
    expect(failure?.getAttribute('role')).toBe('alert')
    expect(failure?.textContent).toContain('Could not duplicate this skill:')
    expect(failure?.textContent).toContain('Not an imported skill id: a')
    expect(onForked).not.toHaveBeenCalled()
  })
})
