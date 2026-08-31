// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ChatSession } from '@/stores/session-store'
import { ExportConversationDialog } from './ExportConversationDialog'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const createTurn = (
  id: string,
  role: 'user' | 'agent',
  content: string,
  at: number
): ChatSession['messages'][number] => ({
  id,
  role,
  content,
  status: 'complete',
  eventIds: [],
  createdAt: at,
  updatedAt: at
})

const session: ChatSession = {
  id: 'session-1',
  projectId: 'project-1',
  title: 'Analysis session',
  cwd: '/workspace',
  status: 'idle',
  messages: [
    createTurn('message-u1', 'user', 'First prompt', 1),
    createTurn('message-a1', 'agent', 'First answer.', 2),
    createTurn('message-u2', 'user', 'Second prompt', 3),
    createTurn('message-a2', 'agent', 'Second answer.', 4),
    createTurn('message-u3', 'user', 'Third prompt', 5),
    createTurn('message-a3', 'agent', 'Third answer.', 6)
  ],
  createdAt: 1,
  updatedAt: 6
}

let container: HTMLElement
let root: Root

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

const renderDialog = (
  onExport: (options: unknown) => void = vi.fn()
): { onClose: ReturnType<typeof vi.fn> } => {
  const onClose = vi.fn()
  act(() => {
    root.render(
      <ExportConversationDialog session={session} onClose={onClose} onExport={onExport} />
    )
  })
  return { onClose }
}

const setInputValue = (label: string, value: string): HTMLInputElement => {
  const input = [...document.body.querySelectorAll<HTMLInputElement>('input')].find(
    (candidate) => candidate.getAttribute('aria-label') === label
  )
  if (!input) throw new Error(`input with aria-label "${label}" not found`)
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  act(() => {
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  return input
}

const clickRadio = (label: string): void => {
  const input = [...document.body.querySelectorAll<HTMLInputElement>('input[type="radio"]')].find(
    (candidate) => candidate.parentElement?.textContent?.includes(label)
  )
  if (!input) throw new Error(`radio with label "${label}" not found`)
  act(() => input.click())
}

const clickExport = (): void => {
  act(() => {
    ;[...document.body.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === 'Export')
      ?.click()
  })
}

describe('ExportConversationDialog', () => {
  it('renders the session title, turn count and defaults to Markdown + all rounds', () => {
    renderDialog()

    expect(document.body.textContent).toContain('Export conversation')
    expect(document.body.textContent).toContain('Analysis session')
    expect(document.body.textContent).toContain('3 turns total')
    expect(document.body.textContent).toContain('All rounds')
    expect(document.body.textContent).toContain('Custom range')
    expect(document.body.textContent).toContain('Single round')
  })

  it('exports every round as Markdown by default', () => {
    const onExport = vi.fn()
    renderDialog(onExport)

    clickExport()

    expect(onExport).toHaveBeenCalledWith({ format: 'markdown', rounds: undefined })
  })

  it('exports as PDF when the PDF format is selected', () => {
    const onExport = vi.fn()
    renderDialog(onExport)

    clickRadio('PDF')
    clickExport()

    expect(onExport).toHaveBeenCalledWith({ format: 'pdf', rounds: undefined })
  })

  it('exports only the selected round range', () => {
    const onExport = vi.fn()
    renderDialog(onExport)

    clickRadio('Custom range')
    setInputValue('From round', '2')
    setInputValue('To round', '3')
    clickExport()

    expect(onExport).toHaveBeenCalledWith({ format: 'markdown', rounds: { from: 2, to: 3 } })
  })

  it('treats an empty range end as the last turn', () => {
    const onExport = vi.fn()
    renderDialog(onExport)

    clickRadio('Custom range')
    setInputValue('From round', '2')
    clickExport()

    expect(onExport).toHaveBeenCalledWith({ format: 'markdown', rounds: { from: 2, to: 3 } })
  })

  it('exports a single round', () => {
    const onExport = vi.fn()
    renderDialog(onExport)

    clickRadio('Single round')
    setInputValue('Round', '2')
    clickExport()

    expect(onExport).toHaveBeenCalledWith({ format: 'markdown', rounds: { from: 2, to: 2 } })
  })

  it('disables export and shows a hint for an inverted range', () => {
    const onExport = vi.fn()
    renderDialog(onExport)

    clickRadio('Custom range')
    setInputValue('From round', '3')
    setInputValue('To round', '2')

    expect(document.body.textContent).toContain('Invalid round range')
    const exportButton = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === 'Export'
    )
    expect(exportButton?.disabled).toBe(true)
    clickExport()
    expect(onExport).not.toHaveBeenCalled()
  })

  it('closes via the Cancel button and the close button', () => {
    const { onClose } = renderDialog()

    act(() => {
      ;[...document.body.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent?.trim() === 'Cancel')
        ?.click()
    })
    expect(onClose).toHaveBeenCalledTimes(1)

    act(() => {
      ;[...document.body.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.getAttribute('aria-label') === 'Close')
        ?.click()
    })
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})
