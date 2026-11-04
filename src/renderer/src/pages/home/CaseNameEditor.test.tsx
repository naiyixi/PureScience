// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useProjectStore } from '@/stores/project-store'

import { CaseNameEditor } from './CaseNameEditor'

// The editor's one promise: what it says afterwards matches what the store answered. A save that reads
// "saved" while the project row did not change would be worse than no editor at all.

const mount = (overrides: {
  updateProject: ReturnType<typeof vi.fn>
  title?: string
  summary?: string
}): void => {
  useProjectStore.setState({ updateProject: overrides.updateProject as never })
  render(
    <CaseNameEditor
      projectId="p1"
      title={overrides.title ?? ''}
      summary={'summary' in overrides ? overrides.summary : undefined}
    />
  )
}

const type = (slot: string, value: string): void => {
  fireEvent.change(document.querySelector(`[data-slot="${slot}"]`) as HTMLElement, {
    target: { value }
  })
}

afterEach(() => cleanup())

describe('naming a case in the project row', () => {
  it('keeps Save disabled until something actually changed', () => {
    mount({ updateProject: vi.fn() })

    const save = document.querySelector('[data-slot="case-name-save"]') as HTMLButtonElement
    expect(save.disabled).toBe(true)

    type('case-name-title', 'EGFR 选择性审计')
    expect(save.disabled).toBe(false)
  })

  it('writes both fields through the project update and says so', async () => {
    const updateProject = vi.fn().mockResolvedValue({
      id: 'p1',
      caseTitle: 'EGFR 选择性审计',
      caseSummary: '一句话说清这个案例'
    })
    mount({ updateProject })

    type('case-name-title', '  EGFR 选择性审计  ')
    type('case-name-summary', '一句话说清这个案例')
    fireEvent.click(document.querySelector('[data-slot="case-name-save"]') as HTMLElement)

    await waitFor(() =>
      expect(updateProject).toHaveBeenCalledWith({
        id: 'p1',
        caseTitle: '  EGFR 选择性审计  ',
        caseSummary: '一句话说清这个案例'
      })
    )
    // Trimming is the repository's job, not this form's: the request carries what was typed.
    expect(await screen.findByText('Saved to the project.')).toBeTruthy()
  })

  it('does not claim it saved when the store reports a refusal', async () => {
    mount({ updateProject: vi.fn().mockResolvedValue(undefined) })

    type('case-name-title', 'EGFR 选择性审计')
    fireEvent.click(document.querySelector('[data-slot="case-name-save"]') as HTMLElement)

    const failed = await waitFor(() => {
      const node = document.querySelector('[data-slot="case-name-failed"]')
      expect(node).toBeTruthy()
      return node as HTMLElement
    })
    expect(failed.textContent).toContain('Not saved')
    expect(document.querySelector('[data-slot="case-name-saved"]')).toBeNull()
  })

  it('shows the thrown message when the channel itself is missing', async () => {
    mount({
      updateProject: vi
        .fn()
        .mockRejectedValue(new Error("No handler registered for 'projects:update'"))
    })

    type('case-name-title', 'EGFR 选择性审计')
    fireEvent.click(document.querySelector('[data-slot="case-name-save"]') as HTMLElement)

    const failed = await waitFor(() => {
      const node = document.querySelector('[data-slot="case-name-failed"]')
      expect(node).toBeTruthy()
      return node as HTMLElement
    })
    expect(failed.textContent).toContain("No handler registered for 'projects:update'")
  })

  it('starts from the stored name, not from an empty box', () => {
    mount({ updateProject: vi.fn(), title: 'EGFR 选择性审计', summary: '一句话' })

    expect(
      (document.querySelector('[data-slot="case-name-title"]') as HTMLInputElement).value
    ).toBe('EGFR 选择性审计')
    expect(
      (document.querySelector('[data-slot="case-name-summary"]') as HTMLInputElement).value
    ).toBe('一句话')
  })
})
