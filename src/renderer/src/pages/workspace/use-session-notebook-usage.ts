import { useEffect, useState } from 'react'

import type { SessionNotebookUsage } from '../../../../shared/session-persistence'

type NotebookUsageReading = { sessionId: string; usage: SessionNotebookUsage }

/**
 * What one session's own notebook run data occupies on disk, read while its confirmation is open.
 *
 * The reading is stamped with the session it belongs to instead of being cleared on a session change: a
 * synchronous reset inside the effect is a cascading render (`react-hooks/set-state-in-effect`), and a stale
 * figure shown next to a different session's title would be worse than one missing line. A caller that does
 * not see its own session in the stamp reads `null` and says nothing.
 *
 * A failed read is a state of its own: it resolves to `unavailable`, so the confirmation can say the size
 * could not be measured. Returning `null` there would read as "there is nothing else to lose".
 */
const useSessionNotebookUsage = (
  projectId: string | undefined,
  sessionId: string | undefined
): SessionNotebookUsage | null => {
  const [reading, setReading] = useState<NotebookUsageReading | null>(null)

  useEffect(() => {
    if (!projectId || !sessionId) return
    let alive = true
    void window.api?.sessions?.readNotebookUsage({ projectId, sessionId })?.then(
      (usage) => {
        if (alive) setReading({ sessionId, usage })
      },
      () => {
        if (alive) setReading({ sessionId, usage: { state: 'unavailable', reason: 'unreadable' } })
      }
    )
    return () => {
      alive = false
    }
  }, [projectId, sessionId])

  return reading && reading.sessionId === sessionId ? reading.usage : null
}

export { useSessionNotebookUsage }
