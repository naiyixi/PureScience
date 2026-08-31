import { useLanguage } from '@/i18n'
import { useMessageScroller, useMessageScrollerVisibility } from '@/components/ui/message-scroller'

// Run-marks navigation rail: one dot per user turn along the right edge of a long transcript.
// Clicking a dot scrolls the conversation to that turn; the dot for the turn currently in view
// is highlighted. Below the minimum turn count the rail is hidden (short conversations scroll
// trivially and the rail would only be noise).

export const RUN_MARKS_MIN_TURNS = 8

const RAIL_MAX_HEIGHT_PX = 416
const DOT_SIZE_CLASS = 'size-[7px]'

const renderDotTop = (index: number, total: number): string => {
  if (total <= 1) return '50%'
  return `${(index / (total - 1)) * 100}%`
}

export const RunMarksRail = ({
  userMessageIds
}: {
  userMessageIds: readonly string[]
}): React.JSX.Element | null => {
  const { t } = useLanguage()
  const { scrollToMessage } = useMessageScroller()
  const { visibleMessageIds } = useMessageScrollerVisibility()

  if (userMessageIds.length < RUN_MARKS_MIN_TURNS) return null

  // The active mark is the last user turn whose message is inside the visible window; it tracks
  // the reading position as the user scrolls.
  const visible = new Set(visibleMessageIds)
  let activeIndex = -1
  for (let index = 0; index < userMessageIds.length; index += 1) {
    if (visible.has(userMessageIds[index])) activeIndex = index
  }

  return (
    <div
      data-testid="run-marks-rail"
      className="pointer-events-none absolute right-1 top-1/2 z-10 -translate-y-1/2"
      aria-hidden="true"
    >
      <div
        className="pointer-events-auto relative w-3.5"
        style={{ height: RAIL_MAX_HEIGHT_PX, maxHeight: 'min(62vh, 26rem)' }}
      >
        {userMessageIds.map((messageId, index) => {
          const isActive = index === activeIndex
          return (
            <button
              key={messageId}
              type="button"
              tabIndex={-1}
              aria-label={t('ws.runMarkJump').replace('{turn}', String(index + 1))}
              data-testid="run-mark"
              data-active={isActive ? 'true' : 'false'}
              className={`absolute left-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-border-200 bg-bg-300 transition-colors duration-150 hover:border-accent hover:bg-accent/60 data-[active=true]:border-accent data-[active=true]:bg-accent ${DOT_SIZE_CLASS}`}
              style={{ top: renderDotTop(index, userMessageIds.length) }}
              onClick={() => scrollToMessage(messageId, { align: 'start', behavior: 'smooth' })}
            />
          )
        })}
      </div>
    </div>
  )
}
