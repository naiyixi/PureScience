// The list-tier projection of a session.
//
// Measured on the real corpus: the list payload is 55.4 MB, and the three heaviest contributors are
// `conversationGraph` (44% of a document), `activities` (27%) and the flat message array. All of them are
// only ever read for the session a reader is actually looking at, so the list can carry everything else
// and defer them. `Omit` (rather than a hand-written shape) is deliberate: a field added later is carried
// by default, and only the four heavy ones have to be opted out of explicitly.
import type {
  PersistedChatMessage,
  PersistedChatSession,
  PersistedSessionManifest
} from './session-persistence'

// The projected fields. `messages`/`conversationGraph`/`activities`/`activityGroups` are dropped: they are
// the active Branch's content, not the session's identity, and they are what makes the payload large.
export type SessionCatalogSummary = Omit<
  PersistedChatSession,
  'messages' | 'conversationGraph' | 'activities' | 'activityGroups'
> & {
  // How many messages the document holds, so a list can show a count without the messages themselves.
  messageCount: number
  // The last agent message, which the Task API's own summary reads (`task-runner.ts`). Carried here
  // because dropping it would silently turn every task summary's output into undefined.
  lastAgentMessage?: string
}

const lastAgentMessageOf = (messages: PersistedChatMessage[] | undefined): string | undefined =>
  messages === undefined
    ? undefined
    : [...messages].reverse().find((message) => message.role === 'agent')?.content

export const summarizeSessionCatalogEntry = (
  session: PersistedChatSession
): SessionCatalogSummary => {
  const {
    messages,
    conversationGraph: _conversationGraph,
    activities: _activities,
    activityGroups: _activityGroups,
    ...rest
  } = session
  const summary: SessionCatalogSummary = {
    ...rest,
    messageCount: messages?.length ?? 0
  }
  const lastAgentMessage = lastAgentMessageOf(messages)
  if (lastAgentMessage !== undefined) summary.lastAgentMessage = lastAgentMessage
  return summary
}

export const summarizeSessionCatalog = (
  sessions: readonly PersistedChatSession[]
): SessionCatalogSummary[] => sessions.map(summarizeSessionCatalogEntry)

// The list tier's payload: the summaries plus the last-open pointer. The pointer is small and hydration needs
// it to decide which session to open, so leaving it behind would force a second full read to find it.
export type SessionCatalogResult = {
  sessions: SessionCatalogSummary[]
  manifest?: PersistedSessionManifest
}
