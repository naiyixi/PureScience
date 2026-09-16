// @vitest-environment jsdom
// The trimmed-history notice: a bounded conversation must say what it lost, and stay quiet otherwise.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

let container: HTMLDivElement
let root: Root

const render = async (
  retention: { droppedMessages: number; droppedBefore: number } | undefined
): Promise<void> => {
  const { TrimmedHistoryNotice } = await import('./TrimmedHistoryNotice')
  act(() => {
    root.render(<TrimmedHistoryNotice retention={retention} />)
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
})

describe('TrimmedHistoryNotice', () => {
  it('states how many messages are gone and where the record resumes', async () => {
    await render({ droppedMessages: 1_204, droppedBefore: Date.UTC(2026, 0, 2, 3, 4) })

    const notice = container.querySelector('[data-testid="trimmed-history-notice"]')
    expect(notice).not.toBeNull()
    const text = notice?.textContent ?? ''
    expect(text).toContain('1204')
    expect(text).toMatch(/earlier messages are no longer stored/)
    expect(text).toMatch(/record resumes at/)
  })

  it('renders nothing for a conversation that never lost a message', async () => {
    await render(undefined)

    expect(container.querySelector('[data-testid="trimmed-history-notice"]')).toBeNull()
  })
})
