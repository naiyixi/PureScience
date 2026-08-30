// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

import { SkillsPanel } from './SkillsPanel'
import { createInitialSettingsState, useSettingsStore } from '@/stores/settings-store'
import { useSpecialistStore } from '@/stores/specialist-store'
import { useCatalogTagsStore } from '@/stores/catalog-tags-store'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const seedSkills = [
  {
    id: 'a',
    name: 'Alpha',
    description: 'First',
    source: 'featured' as const,
    updatedAt: '2026-07-08T00:00:00.000Z',
    enabled: true
  },
  {
    id: 'b',
    name: 'Beta',
    description: 'Second',
    source: 'featured' as const,
    updatedAt: '2026-07-08T00:00:00.000Z',
    enabled: false
  },
  {
    id: 'personal-mine',
    name: 'Mine',
    description: 'Custom',
    source: 'personal' as const,
    updatedAt: '2026-07-08T00:00:00.000Z',
    enabled: true
  }
]

let container: HTMLDivElement
let root: Root
let setSkillEnabled: Mock<(id: string, enabled: boolean) => Promise<void>>
let deleteSkill: Mock<(id: string) => Promise<void>>

beforeEach(() => {
  window.localStorage.clear()
  useCatalogTagsStore.setState({ entries: {} })
  setSkillEnabled = vi.fn<(id: string, enabled: boolean) => Promise<void>>().mockResolvedValue(
    undefined
  )
  deleteSkill = vi.fn<(id: string) => Promise<void>>().mockResolvedValue(undefined)
  useSettingsStore.setState({
    ...createInitialSettingsState(),
    skills: seedSkills,
    loadSkills: vi.fn().mockResolvedValue(undefined),
    setSkillEnabled,
    deleteSkill,
    setConversationSkillImportEnabled: vi.fn().mockResolvedValue(undefined),
    createSkill: vi.fn().mockResolvedValue(undefined),
    updateSkill: vi.fn().mockResolvedValue(undefined),
    importSkill: vi.fn().mockResolvedValue({ status: 'imported', id: 'x', skills: [] })
  })
  useSpecialistStore.setState({
    items: [],
    isLoaded: true
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

const renderPanel = (): void => {
  act(() => {
    root.render(<SkillsPanel view={{ kind: 'list' }} onNavigate={vi.fn()} />)
  })
}

const skillRow = (name: string): HTMLLIElement => {
  const row = [...container.querySelectorAll<HTMLLIElement>('[data-slot="settings-list-row"]')].find(
    (candidate) => candidate.textContent?.includes(name)
  )
  if (!row) throw new Error(`skill row "${name}" not found`)
  return row
}

const clickIn = (element: Element, selector: string): void => {
  const target = element.querySelector<HTMLElement>(selector)
  if (!target) throw new Error(`"${selector}" not found inside element`)
  act(() => target.click())
}

const clickButtonByText = (text: string): HTMLButtonElement | undefined => {
  const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => candidate.textContent?.trim() === text
  )
  act(() => button?.click())
  return button
}

const setTagInput = (row: HTMLLIElement, value: string): void => {
  clickIn(row, '[data-testid="catalog-tag-add"]')
  const input = row.querySelector<HTMLInputElement>('[data-testid="catalog-tag-input"]')
  expect(input).not.toBeNull()
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input?.dispatchEvent(new Event('input', { bubbles: true }))
  })
  act(() => {
    input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
}

describe('SkillsPanel catalog tags and favorites', () => {
  it('favorites a skill and filters the list to favorites', () => {
    renderPanel()

    expect(container.textContent).toContain('Alpha')
    expect(container.textContent).toContain('Mine')

    clickIn(skillRow('Alpha'), '[aria-label="Favorite skill Alpha"]')
    clickButtonByText('Favorites')

    expect(container.textContent).toContain('Alpha')
    expect(container.textContent).not.toContain('Beta')
    expect(container.textContent).not.toContain('Mine')

    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="catalog-filter-all"]')?.click()
    })
    expect(container.textContent).toContain('Mine')
  })

  it('tags a skill and filters the catalog by the tag chip', () => {
    renderPanel()

    setTagInput(skillRow('Alpha'), 'docking')
    expect(skillRow('Alpha').textContent).toContain('docking')

    const chip = [...container.querySelectorAll<HTMLButtonElement>('[data-testid="catalog-filter-tag"]')].find(
      (candidate) => candidate.textContent?.trim() === 'docking'
    )
    expect(chip).toBeDefined()
    act(() => chip?.click())

    expect(container.textContent).toContain('Alpha')
    expect(container.textContent).not.toContain('Beta')
    expect(container.textContent).not.toContain('Mine')
  })

  it('filters by owner scope: main agent vs specialist skills', () => {
    useSpecialistStore.setState({
      items: [
        {
          kind: 'custom',
          id: 'specialist-1',
          name: 'ANALYST',
          displayName: 'Analyst',
          description: 'Analysis specialist',
          systemPrompt: 'You analyze.',
          enabled: true,
          capabilityMode: 'selected',
          fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
          selectedCapabilities: { skillIds: ['b'], connectorIds: [], connectorTools: [] },
          revision: 1
        }
      ],
      isLoaded: true
    })
    renderPanel()

    clickButtonByText('Specialist skills')
    expect(container.textContent).toContain('Beta')
    expect(container.textContent).not.toContain('Alpha')
    expect(container.textContent).not.toContain('Mine')

    clickButtonByText('Main agent')
    expect(container.textContent).toContain('Alpha')
    expect(container.textContent).toContain('Mine')
    expect(container.textContent).not.toContain('Beta')
  })

  it('shows an owner badge on specialist-bound skills', () => {
    useSpecialistStore.setState({
      items: [
        {
          kind: 'custom',
          id: 'specialist-1',
          name: 'ANALYST',
          displayName: 'Analyst',
          description: 'Analysis specialist',
          systemPrompt: 'You analyze.',
          enabled: true,
          capabilityMode: 'selected',
          fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
          selectedCapabilities: { skillIds: ['b'], connectorIds: [], connectorTools: [] },
          revision: 1
        }
      ],
      isLoaded: true
    })
    renderPanel()

    expect(skillRow('Beta').textContent).toContain('Specialists')
    expect(skillRow('Alpha').textContent).toContain('Main agent')
  })
})

describe('SkillsPanel batch actions', () => {
  it('bulk disables every selected enabled skill and clears the selection', async () => {
    renderPanel()

    clickButtonByText('Batch actions')
    expect(container.querySelector('[data-testid="skills-batch-bar"]')).not.toBeNull()

    clickButtonByText('Select all')
    expect(container.textContent).toContain('3 selected')

    clickButtonByText('Disable')
    expect(setSkillEnabled).toHaveBeenCalledWith('a', false)
    expect(setSkillEnabled).toHaveBeenCalledWith('personal-mine', false)
    expect(setSkillEnabled).not.toHaveBeenCalledWith('b', false)

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(container.textContent).toContain('0 selected')
  })

  it('bulk enable turns disabled skills back on', () => {
    renderPanel()

    clickButtonByText('Batch actions')
    clickButtonByText('Select all')
    clickButtonByText('Enable')

    expect(setSkillEnabled).toHaveBeenCalledWith('b', true)
    expect(setSkillEnabled).not.toHaveBeenCalledWith('a', true)
  })

  it('bulk delete skips protected built-in skills and reports the count', async () => {
    renderPanel()

    clickButtonByText('Batch actions')
    clickButtonByText('Select all')
    clickButtonByText('Delete')

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(deleteSkill).toHaveBeenCalledTimes(1)
    expect(deleteSkill).toHaveBeenCalledWith('personal-mine')
    expect(container.textContent).toContain('Skipped 2 built-in skills')
  })
})
