import type { ChatSession } from '@/stores/session-store'

// The transcript's activity channel.
//
// Tool activities and their groups arrive several times a turn — every tool event, plus every status change
// — and they used to travel inside the session props: the frozen comparators (`transcript-render-identity`)
// compared them, so each event re-minted the props and re-rendered the panel, the list container and the
// panel's chrome with it. One activity update dragged nine icons along, eight of which the update had not
// touched (see docs/evidence/2026-09-25-interaction-smoothness.md).
//
// They are volatile data in exactly the way the streamed text is, so the container that renders them reads
// them from the store and the comparators ignore them. Subscribing is safe without a custom equality
// function: the projected arrays keep their identity across a *text* chunk and change only when an activity
// does (`activity-subscription.test.ts` pins that, because a selector returning a fresh array per chunk
// would re-render the list container per chunk and undo the text channel's win).
export type ActivitySource = {
  sessions: readonly {
    id: string
    activities?: ChatSession['activities']
    activityGroups?: ChatSession['activityGroups']
  }[]
}

// `undefined` means "this state does not hold the session" (an isolated or immutable surface): the caller
// falls back to the props it was handed, the same direction as the text channel.
export const selectLiveSessionActivities = (
  state: ActivitySource,
  sessionId: string | undefined
): ChatSession['activities'] | undefined =>
  sessionId ? state.sessions.find((session) => session.id === sessionId)?.activities : undefined

export const selectLiveSessionActivityGroups = (
  state: ActivitySource,
  sessionId: string | undefined
): ChatSession['activityGroups'] | undefined =>
  sessionId ? state.sessions.find((session) => session.id === sessionId)?.activityGroups : undefined
