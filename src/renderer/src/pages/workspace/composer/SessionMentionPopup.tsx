import { useEffect, useId, useMemo, useState } from 'react'

import { useSessionStore } from '@/stores/session-store'

import { useLanguage } from '@/i18n'

// # session reference picker: lists known sessions by title so the composer can reference another
// conversation. Selecting one inserts an atomic # session chip; the agent receives read-only access
// to that session's visible transcript for the current turn.
//
// Like the skill and artifact pickers the composer keeps caret focus while this is open, so the
// navigation keys are handled on document here. That listener is not optional: the editor yields
// Enter/arrows to whichever mention is open, so a picker with no listener leaves Enter neither
// selecting nor submitting and Escape unable to close.

type SessionMentionPopupProps = {
  query: string
  // The active session is excluded so a session cannot reference itself.
  excludeId?: string
  onSelect: (session: { id: string; title: string }) => void
  onClose: () => void
}

const EMPTY_TITLE = '(untitled session)'
// A reference list is meant to be scanned, not scrolled; the picker never lists more than this.
const MAX_ROWS = 20

export const SessionMentionPopup = ({
  query,
  excludeId,
  onSelect,
  onClose
}: SessionMentionPopupProps): React.JSX.Element | null => {
  const { t } = useLanguage()
  const sessions = useSessionStore((state) => state.sessions)
  const listboxId = useId()

  // Filter by title substring, newest first; the active session never appears.
  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const candidates = [...sessions]
      .filter((session) => session.id !== excludeId)
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    if (needle.length === 0) return candidates
    return candidates.filter((session) => (session.title ?? '').toLowerCase().includes(needle))
  }, [sessions, query, excludeId])

  const rows = useMemo(() => matches.slice(0, MAX_ROWS), [matches])

  const [activeIndex, setActiveIndex] = useState(0)

  // Reset the highlight to the top when the query changes (setState-during-render pattern).
  const [lastQuery, setLastQuery] = useState(query)
  if (lastQuery !== query) {
    setLastQuery(query)
    setActiveIndex(0)
  }

  // Keep the highlight within the current row set even after filtering shrinks it.
  const safeIndex = rows.length === 0 ? 0 : Math.min(activeIndex, rows.length - 1)

  // Navigation keys live on document while mounted, mirroring the skill/artifact pickers.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        if (rows.length > 0) setActiveIndex((safeIndex + 1) % rows.length)
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        if (rows.length > 0) setActiveIndex((safeIndex - 1 + rows.length) % rows.length)
      } else if (event.key === 'Enter') {
        // The picker owns Enter for its entire mounted lifetime, because the editor yields while a
        // mention is open. With a highlighted row it selects it; with nothing to select it dismisses
        // the picker, so the key always does something and the next Enter submits the draft.
        event.preventDefault()
        const active = rows[safeIndex]
        if (active) onSelect({ id: active.id, title: active.title || EMPTY_TITLE })
        else onClose()
      } else if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [rows, safeIndex, onSelect, onClose])

  return (
    <div className="absolute bottom-full left-0 z-50 mb-1 w-72 max-w-[calc(100%-1rem)] rounded-lg border border-border bg-popover text-popover-foreground shadow-lg">
      {rows.length === 0 ? (
        <p className="px-2 py-1.5 text-sm text-muted-foreground">{t('ui.nomatchingsessions')}</p>
      ) : (
        <ul
          id={listboxId}
          role="listbox"
          aria-label={t('conversation.referenceSession')}
          className="max-h-56 overflow-y-auto p-1"
        >
          {rows.map((session, index) => {
            const isActive = index === safeIndex
            return (
              <li
                key={session.id}
                id={`${listboxId}-option-${index}`}
                role="option"
                aria-selected={isActive}
                onMouseEnter={() => setActiveIndex(index)}
                // Keep the editor focused/caret intact so the mention stays open long enough for the click.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onSelect({ id: session.id, title: session.title || EMPTY_TITLE })}
                className={`flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground${
                  isActive ? ' bg-accent text-accent-foreground' : ''
                }`}
              >
                <span className="shrink-0 text-muted-foreground">#</span>
                <span className="min-w-0 flex-1 truncate">{session.title || EMPTY_TITLE}</span>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
