import { useCallback, useRef, useSyncExternalStore } from 'react'

import { useSessionStore, type ChatSession } from '@/stores/session-store'
import { carriesSameSessionListStructure } from './transcript-render-identity'

// The session list, as the *rendering* side should see it.
//
// A streamed chunk rewrites the session list, the session it belongs to and the message being streamed
// into, several times a second. Nothing in the workspace's markup depends on that text — the transcript's
// containers, the sidebar, the composer all render structure — so re-rendering them for it was pure
// waste: every chunk re-rendered the page, the panel and the scroller, and re-walked the transcript's
// whole element tree in the commit phase. The frame metrics cannot see that cost, which is why it survived
// (docs/evidence/2026-09-25-interaction-smoothness.md).
//
// This hook keeps the previous snapshot whenever the new one differs only by streamed text, so the page
// renders from the same objects until something structural actually changes. Render counts for one chunk
// go from `page 1 / panel 1 / scroller 1 / leaf 1` to `page 0 / panel 0 / scroller 0 / leaf 1`; the one
// message that renders the text re-renders through its own subscription (message-content-subscription.ts).
//
// Deliberate consequence: surfaces that *read* the session list through this hook hold the last structural
// snapshot, so a title or status is at most one chunk stale. Anything that consumes the *text* — a message
// item, an export taken from a menu — must read the store directly (`useSessionStore.getState()`), and the
// surfaces that do are listed in docs/evidence/2026-09-25-interaction-smoothness.md.
//
// The snapshot is cached per hook instance rather than per module: a module-level cache would leak one
// workspace's list into the next mount (and into the next test), while a per-instance cache can only ever
// hold a list this mount already rendered.
export const useRenderSessions = (): ChatSession[] => {
  const stableSessionsRef = useRef<ChatSession[] | undefined>(undefined)

  const getSnapshot = useCallback((): ChatSession[] => {
    const sessions = useSessionStore.getState().sessions
    const stableSessions = stableSessionsRef.current
    if (
      stableSessions !== undefined &&
      stableSessions !== sessions &&
      carriesSameSessionListStructure(stableSessions, sessions)
    ) {
      return stableSessions
    }

    stableSessionsRef.current = sessions
    return sessions
  }, [])

  return useSyncExternalStore(useSessionStore.subscribe, getSnapshot, getSnapshot)
}
