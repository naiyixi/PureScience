import { useEffect } from 'react'

import { useMessageScroller } from '@/components/ui/message-scroller'
import { useNavigationStore } from '@/stores/navigation-store'

import { MESSAGE_FOCUS_RETRY_MS, shouldRetryMessageFocus } from './message-focus'

// Lands the workspace on the message a palette hit pointed at.
//
// The intent is consumed up front, so a remount can never replay a scroll the user already saw; the
// remaining work is repeating the scroll a bounded number of times (see ./message-focus).

export const MessageFocusConsumer = ({ sessionId }: { sessionId: string }): null => {
  const { scrollToMessage } = useMessageScroller()
  const pendingMessageFocus = useNavigationStore((state) => state.pendingMessageFocus)
  const consumeMessageFocus = useNavigationStore((state) => state.consumeMessageFocus)

  useEffect(() => {
    if (!pendingMessageFocus || pendingMessageFocus.sessionId !== sessionId) return
    // Only the targeted session can consume the intent; a stale intent for another session stays put.
    const focus = consumeMessageFocus(sessionId)
    if (!focus) return

    let attempt = 0
    const scroll = (): void => {
      attempt += 1
      scrollToMessage(focus.messageId, { align: 'start', behavior: 'smooth' })
    }
    scroll()

    const timer = setInterval(() => {
      if (!shouldRetryMessageFocus(attempt)) {
        clearInterval(timer)
        return
      }
      scroll()
    }, MESSAGE_FOCUS_RETRY_MS)

    return () => clearInterval(timer)
  }, [consumeMessageFocus, pendingMessageFocus, scrollToMessage, sessionId])

  return null
}
