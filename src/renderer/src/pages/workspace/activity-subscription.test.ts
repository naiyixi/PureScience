import { describe, expect, it, beforeEach } from 'vitest'

import { useSessionStore } from '@/stores/session-store'

import {
  selectLiveSessionActivities,
  selectLiveSessionActivityGroups
} from './activity-subscription'

const SESSION_ID = 'activity-subscription-session'

const pushText = (eventIndex: number, content: string): void => {
  useSessionStore.getState().appendAgentMessageChunk({
    sessionId: SESSION_ID,
    streamId: 'activity-subscription-stream',
    eventId: `event-${eventIndex}`,
    content
  })
}

const pushActivity = (status: 'pending' | 'completed'): void => {
  useSessionStore.getState().upsertToolActivity({
    sessionId: SESSION_ID,
    toolCallId: 'tool-1',
    eventId: `event-activity-${status}`,
    toolKind: 'fetch',
    providerToolName: 'WebSearch',
    title: '"public data repositories"',
    status
  })
}

beforeEach(() => {
  useSessionStore.setState({ sessions: [], selectedSessionId: undefined })
  useSessionStore.getState().appendUserMessage({ sessionId: SESSION_ID, content: 'Ask' })
  pushText(1, 'partial')
})

describe('activity selectors', () => {
  it('reads the session the container is rendering', () => {
    const state = useSessionStore.getState()

    expect(selectLiveSessionActivities(state, SESSION_ID)).toBe(
      state.sessions.find((session) => session.id === SESSION_ID)?.activities
    )
    expect(selectLiveSessionActivityGroups(state, SESSION_ID)).toBe(
      state.sessions.find((session) => session.id === SESSION_ID)?.activityGroups
    )
  })

  it('answers undefined without a session id, so isolated surfaces fall back to their props', () => {
    const state = useSessionStore.getState()

    expect(selectLiveSessionActivities(state, undefined)).toBeUndefined()
    expect(selectLiveSessionActivityGroups(state, undefined)).toBeUndefined()
  })

  it('keeps its identity across a text chunk', () => {
    // The whole reason a plain subscription is safe here: a selector that returned a fresh array per chunk
    // would re-render the list container per chunk and undo the text channel's win.
    const before = selectLiveSessionActivities(useSessionStore.getState(), SESSION_ID)
    const groupsBefore = selectLiveSessionActivityGroups(useSessionStore.getState(), SESSION_ID)

    pushText(2, ' more')

    expect(selectLiveSessionActivities(useSessionStore.getState(), SESSION_ID)).toBe(before)
    expect(selectLiveSessionActivityGroups(useSessionStore.getState(), SESSION_ID)).toBe(
      groupsBefore
    )
  })

  it('changes when an activity does', () => {
    const before = selectLiveSessionActivities(useSessionStore.getState(), SESSION_ID)

    pushActivity('pending')

    const after = selectLiveSessionActivities(useSessionStore.getState(), SESSION_ID)
    expect(after).not.toBe(before)
    expect(after).toHaveLength(1)
    expect(after?.[0]?.status).toBe('pending')

    pushActivity('completed')

    expect(selectLiveSessionActivities(useSessionStore.getState(), SESSION_ID)?.[0]?.status).toBe(
      'completed'
    )
  })
})
