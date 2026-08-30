// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SkillsPanel } from './SkillsPanel'
import { createInitialSettingsState, useSettingsStore } from '@/stores/settings-store'

let container: HTMLDivElement
let root: Root

const restrictedSkill = {
  id: 'nc-skill',
  name: 'NC Skill',
  description: 'Restricted',
  source: 'featured' as const,
  updatedAt: '2026-07-08T00:00:00.000Z',
  enabled: false,
  license: 'CC-BY-NC-4.0'
}

const openSkill = {
  id: 'mit-skill',
  name: 'MIT Skill',
  description: 'Open',
  source: 'featured' as const,
  updatedAt: '2026-07-08T00:00:00.000Z',
  enabled: false,
  license: 'MIT'
}

beforeEach(() => {
  useSettingsStore.setState({
    ...createInitialSettingsState(),
    skills: [restrictedSkill, openSkill],
    loadSkills: vi.fn().mockResolvedValue(undefined),
    setSkillEnabled: vi.fn().mockResolvedValue(undefined),
    setConversationSkillImportEnabled: vi.fn().mockResolvedValue(undefined),
    createSkill: vi.fn().mockResolvedValue(undefined),
    updateSkill: vi.fn().mockResolvedValue(undefined),
    deleteSkill: vi.fn().mockResolvedValue(undefined),
    importSkill: vi.fn().mockResolvedValue({ status: 'imported', id: 'imported-foo', skills: [] }),
    importSkillZip: vi
      .fn()
      .mockResolvedValue({ status: 'imported', id: 'imported-zip', skills: [] }),
    importSkillZipBatch: vi.fn().mockResolvedValue({
      results: [{ subPath: '', status: 'imported', id: 'imported-zip' }],
      skills: []
    }),
    previewSkillZip: vi.fn().mockResolvedValue({ previews: [] }),
    useIntent: 'commercial'
  })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const render = (): void => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root.render(<SkillsPanel view={{ kind: 'list' }} onNavigate={() => undefined} />)
  })
}

const toggleSkill = (name: string): void => {
  const toggle = [...container.querySelectorAll<HTMLButtonElement>('[role="switch"]')].find(
    (button) => button.getAttribute('aria-label')?.includes(name)
  )
  if (!toggle) throw new Error(`toggle for ${name} not found`)
  act(() => toggle.click())
}

describe('SkillsPanel licensed-skill confirmation', () => {
  it('asks for confirmation before enabling a restricted-license skill under commercial intent', () => {
    render()
    toggleSkill('NC Skill')
    expect(document.body.textContent).toContain('CC-BY-NC-4.0')
    expect(useSettingsStore.getState().setSkillEnabled).not.toHaveBeenCalled()
  })

  it('enables the restricted skill after confirming', () => {
    render()
    toggleSkill('NC Skill')
    const confirm = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.includes('确认并启用') || button.textContent?.includes('Confirm and enable')
    )
    if (!confirm) throw new Error('confirm button not found')
    act(() => confirm.click())
    expect(useSettingsStore.getState().setSkillEnabled).toHaveBeenCalledWith('nc-skill', true)
  })

  it('does not confirm for a permissive-license skill', () => {
    render()
    toggleSkill('MIT Skill')
    expect(document.body.textContent).not.toContain('CC-BY-NC')
    expect(useSettingsStore.getState().setSkillEnabled).toHaveBeenCalledWith('mit-skill', true)
  })

  it('enables restricted skills directly under non-commercial intent', () => {
    useSettingsStore.setState({ useIntent: 'non-commercial' })
    render()
    toggleSkill('NC Skill')
    expect(document.body.textContent).not.toContain('CC-BY-NC-4.0')
    expect(useSettingsStore.getState().setSkillEnabled).toHaveBeenCalledWith('nc-skill', true)
  })
})
