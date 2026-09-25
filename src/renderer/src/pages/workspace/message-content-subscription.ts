import type { ChatMessage } from '@/stores/session-store'

// The transcript's text channel.
//
// A streamed chunk replaces the Session object, the messages array and the streaming message — several
// times a second. Containers above the transcript deliberately keep their props across those chunks
// (`carriesSameTranscriptStructure`), so the message that is being streamed into must read its own text
// from the store instead of from its props: the props it holds were minted when the structural shape last
// changed, and would freeze the visible text.
//
// The selector returns a plain string, so every other message in the transcript keeps an identical value
// across the chunk and does not re-render — only the streamed message's own value changes.
export type MessageContentSource = {
  sessions: readonly { id: string; messages: readonly ChatMessage[] }[]
}

// `undefined` means "this state does not hold the message" (an isolated or immutable surface, or a
// message whose Session is not loaded): the caller falls back to the content it was handed.
export const selectLiveMessageContent = (
  state: MessageContentSource,
  sessionId: string | undefined,
  messageId: string
): string | undefined => {
  if (!sessionId) return undefined

  const session = state.sessions.find((candidate) => candidate.id === sessionId)
  const message = session?.messages.find((candidate) => candidate.id === messageId)

  return message?.content
}

// A chunk only ever *appends* to the text a message already had, so a store value that does not continue
// the rendered one is not this message's streamed continuation: it is another generation of the same
// Session (an isolated surface rendered from a session object that is not the store's, a session reloaded
// after this render, a test that renders a snapshot). Those surfaces keep what they were handed, which is
// also the safe direction — a retracted or rewritten chunk costs one stale frame until the next structural
// change re-mints the props, never a screen that contradicts the transcript around it.
export const resolveMessageContent = (
  liveContent: string | undefined,
  renderedContent: string
): string =>
  liveContent !== undefined && liveContent.startsWith(renderedContent)
    ? liveContent
    : renderedContent
