import { useId, useMemo } from 'react'

import { useSessionStore } from '@/stores/session-store'

// # session reference picker: lists known sessions by title so the composer can reference another
// conversation. Selecting one inserts an atomic # session chip; the agent receives read-only access
// to that session's visible transcript for the current turn.

type SessionMentionPopupProps = {
  query: string
  // The active session is excluded so a session cannot reference itself.
  excludeId?: string
  onSelect: (session: { id: string; title: string }) => void
  onClose: () => void
}

const EMPTY_TITLE = '(untitled session)'

export const SessionMentionPopup = ({
  query,
  excludeId,
  onSelect,
  onClose
}: SessionMentionPopupProps): React.JSX.Element | null => {
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

  return (
    <div className="absolute bottom-full left-0 z-50 mb-1 w-72 max-w-[calc(100%-1rem)] rounded-lg border border-border bg-popover text-popover-foreground shadow-lg">
      <ul
        id={listboxId}
        role="listbox"
        aria-label="Reference a session"
        className="max-h-56 overflow-y-auto p-1"
      >
        {matches.length === 0 ? (
          <li className="px-2 py-1.5 text-sm text-muted-foreground">No matching sessions</li>
        ) : (
          matches.slice(0, 20).map((session) => (
            <li key={session.id} role="option" aria-selected="false">
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  onSelect({ id: session.id, title: session.title || EMPTY_TITLE })
                  onClose()
                }}
              >
                <span className="shrink-0 text-muted-foreground">#</span>
                <span className="min-w-0 flex-1 truncate">
                  {session.title || EMPTY_TITLE}
                </span>
              </button>
            </li>
          ))
        )}
      </ul>
    </div>
  )
}
