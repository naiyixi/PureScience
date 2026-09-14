// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  MessageScroller,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport
} from '@/components/ui/message-scroller'
import { useNavigationStore } from '@/stores/navigation-store'

import { MessageFocusConsumer } from './MessageFocusConsumer'
import { MESSAGE_FOCUS_ATTEMPTS, shouldRetryMessageFocus } from './message-focus'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  useNavigationStore.setState({ pendingMessageFocus: undefined })
  // jsdom has no layout scrolling; the consumer's job is the intent handoff, which is what we assert.
  Element.prototype.scrollIntoView = vi.fn()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const renderConsumer = async (sessionId: string): Promise<void> => {
  await act(async () => {
    root.render(
      <MessageScrollerProvider>
        <MessageScroller>
          <MessageScrollerViewport>
            <MessageScrollerContent>
              <MessageScrollerItem messageId="message-1">first</MessageScrollerItem>
              <MessageScrollerItem messageId="message-2">second</MessageScrollerItem>
            </MessageScrollerContent>
          </MessageScrollerViewport>
        </MessageScroller>
        <MessageFocusConsumer sessionId={sessionId} />
      </MessageScrollerProvider>
    )
  })
}

describe('shouldRetryMessageFocus', () => {
  it('keeps retrying until the attempt budget is spent, then gives up', () => {
    expect(shouldRetryMessageFocus(0)).toBe(true)
    expect(shouldRetryMessageFocus(MESSAGE_FOCUS_ATTEMPTS - 1)).toBe(true)
    expect(shouldRetryMessageFocus(MESSAGE_FOCUS_ATTEMPTS)).toBe(false)
  })
})

describe('MessageFocusConsumer', () => {
  it('consumes an intent that targets its own session', async () => {
    await renderConsumer('session-a')

    await act(async () => {
      useNavigationStore.getState().requestMessageFocus({
        projectId: 'project-a',
        sessionId: 'session-a',
        messageId: 'message-2'
      })
      await new Promise((resolve) => window.setTimeout(resolve, 20))
    })

    expect(useNavigationStore.getState().pendingMessageFocus).toBeUndefined()
  })

  it('leaves an intent for another session untouched', async () => {
    await renderConsumer('session-a')

    await act(async () => {
      useNavigationStore.getState().requestMessageFocus({
        projectId: 'project-a',
        sessionId: 'session-b',
        messageId: 'message-9'
      })
      await new Promise((resolve) => window.setTimeout(resolve, 20))
    })

    expect(useNavigationStore.getState().pendingMessageFocus).toMatchObject({
      sessionId: 'session-b',
      messageId: 'message-9'
    })
  })
})
