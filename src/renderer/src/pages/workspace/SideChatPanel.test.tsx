// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SideChatPanel } from './SideChatPanel'

const tMock = vi.fn((key: string) => key)

vi.mock('@/i18n', () => ({
  useLanguage: () => ({ t: tMock, lang: 'en' })
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({
    children,
    onClick,
    disabled,
    title,
    ...props
  }: React.PropsWithChildren<{
    onClick?: () => void
    disabled?: boolean
    title?: string
  }>): React.JSX.Element => (
    <button type="button" onClick={onClick} disabled={disabled} title={title} {...props}>
      {children}
    </button>
  )
}))

let container: HTMLElement
let root: Root

const renderPanel = (props: Partial<React.ComponentProps<typeof SideChatPanel>> = {}): void => {
  act(() => {
    root.render(
      <SideChatPanel
        isOpen
        onClose={() => undefined}
        onForward={() => undefined}
        isSessionRunning={false}
        sessionTitle="Test session"
        {...props}
      />
    )
  })
}

const textarea = (): HTMLTextAreaElement => container.querySelector('textarea') as HTMLTextAreaElement

// React-controlled inputs need the native value setter to fire onChange.
const typeInto = (element: HTMLTextAreaElement, value: string): void => {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    'value'
  )?.set as ((value: string) => void) | undefined
  act(() => {
    setter?.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const sendButton = (): HTMLButtonElement =>
  [...container.querySelectorAll('button')].find((button) => button.getAttribute('aria-label') === 'ws.sideChatSend') as HTMLButtonElement
const forwardButton = (): HTMLButtonElement =>
  [...container.querySelectorAll('button')].find((button) => button.textContent === 'ws.sideChatForward') as HTMLButtonElement

describe('SideChatPanel', () => {
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    tMock.mockClear()
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('renders nothing when closed', () => {
    renderPanel({ isOpen: false })
    expect(container.querySelector('aside')).toBeNull()
  })

  it('shows the empty hint when no messages exist', () => {
    renderPanel()
    expect(container.textContent).toContain('ws.sideChatEmpty')
  })

  it('adds a user bubble on send and clears the draft', () => {
    renderPanel()
    typeInto(textarea(), 'Consider using a vector index')
    act(() => sendButton().click())
    expect(container.textContent).toContain('Consider using a vector index')
    expect(textarea().value).toBe('')
  })

  it('does not send empty drafts', () => {
    renderPanel()
    act(() => sendButton().click())
    // No bubble was added: the empty hint is still the only content.
    expect(container.textContent).toContain('ws.sideChatEmpty')
    const userBubbles = [...container.querySelectorAll('div')].filter((element) =>
      element.className.includes('self-end')
    )
    expect(userBubbles).toHaveLength(0)
  })

  it('disables forward until a user message exists', () => {
    renderPanel()
    expect(forwardButton().disabled).toBe(true)
    typeInto(textarea(), 'Try the hybrid retriever')
    act(() => sendButton().click())
    expect(forwardButton().disabled).toBe(false)
  })

  it('forwards all user messages as one advisory', () => {
    const onForward = vi.fn()
    renderPanel({ onForward })
    typeInto(textarea(), 'First note')
    act(() => sendButton().click())
    typeInto(textarea(), 'Second note')
    act(() => sendButton().click())
    act(() => forwardButton().click())
    expect(onForward).toHaveBeenCalledTimes(1)
    expect(onForward).toHaveBeenCalledWith('First note\n\nSecond note')
  })

  it('closes via the close button', () => {
    const onClose = vi.fn()
    renderPanel({ onClose })
    const closeButton = [...container.querySelectorAll('button')].find(
      (button) => button.getAttribute('aria-label') === 'common.close'
    ) as HTMLButtonElement
    act(() => closeButton.click())
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
