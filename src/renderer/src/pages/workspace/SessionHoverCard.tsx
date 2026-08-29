import { createPortal } from 'react-dom'

import type { ChatSession } from '@/stores/session-store'

// A session row hover preview: floats next to the sidebar row and shows the full title
// (scrollable when it overflows) plus the description. Native tooltips appear only after a long
// OS delay and cannot scroll; this card is immediate and readable for long titles.

const HOVER_CARD_WIDTH = 288
const HOVER_CARD_GAP = 8
const HOVER_CARD_MAX_HEIGHT = 220
const VIEWPORT_PADDING = 8

export type SessionHoverAnchor = {
  top: number
  left: number
  width: number
  height: number
}

type SessionHoverCardProps = {
  session: ChatSession
  anchor: SessionHoverAnchor
}

export const SessionHoverCard = ({
  session,
  anchor
}: SessionHoverCardProps): React.JSX.Element => {
  const viewportWidth = window.innerWidth
  const viewportHeight = window.innerHeight

  // Prefer the right of the row; flip to the left when the card would overflow the window.
  const fitsRight =
    anchor.left + anchor.width + HOVER_CARD_GAP + HOVER_CARD_WIDTH + VIEWPORT_PADDING <=
    viewportWidth
  const left = fitsRight
    ? anchor.left + anchor.width + HOVER_CARD_GAP
    : Math.max(VIEWPORT_PADDING, anchor.left - HOVER_CARD_GAP - HOVER_CARD_WIDTH)

  // Clamp vertically so a card on the last row never overflows the bottom of the window.
  const top = Math.min(
    Math.max(VIEWPORT_PADDING, anchor.top),
    viewportHeight - HOVER_CARD_MAX_HEIGHT - VIEWPORT_PADDING
  )

  return createPortal(
    <div
      aria-hidden="true"
      data-testid="session-hover-card"
      className="pointer-events-none fixed z-[80] w-[288px] overflow-hidden rounded-lg border border-border bg-bg-00 shadow-lg"
      style={{ left, top, maxHeight: HOVER_CARD_MAX_HEIGHT }}
    >
      {/* The title scrolls when it is longer than the reserved block — long titles stay readable. */}
      <div
        data-testid="session-hover-card-title"
        className="max-h-[76px] overflow-y-auto px-3 pt-3 text-[13px] font-semibold leading-snug text-text-000"
      >
        {session.title}
      </div>
      {session.description ? (
        <div
          data-testid="session-hover-card-description"
          className="line-clamp-3 px-3 pb-3 pt-1 text-[11px] leading-snug text-text-300"
        >
          {session.description}
        </div>
      ) : null}
    </div>,
    document.body
  )
}
