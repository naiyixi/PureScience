import type { ChatMessage, ChatSession } from '@/stores/session-store'

// A streamed delta replaces the Session object, the messages array and one message, every time a few
// characters arrive. Almost none of that is *structure*: the transcript's shape — which turns exist, in
// what order, with which roles, statuses, attachments, artifacts and revision links — is unchanged. Only
// the text of the turn that is currently streaming actually differs.
//
// The comparators here encode exactly that. They are what lets the workspace keep its *subscription* to
// the session list across a delta (`useRenderSessions`): the page, the panel, the scroller and every
// settled message keep the objects they already rendered, instead of the whole chain re-rendering for
// text that one message renders. The streamed text reaches that message through its own store
// subscription (see message-content-subscription). Before this, every delta re-rendered the page, the
// panel and the scroller, which re-walked the whole transcript's element tree in the commit phase — the
// cost the frame metrics cannot see (see docs/evidence/2026-09-25-interaction-smoothness.md).
//
// Safety direction: these functions may only ever *add* re-renders. A difference they do not recognise
// must return `false` (render again), so a missed case is a lost optimisation, never a stale screen. Own
// fields are enumerated rather than listed, so a new field on ChatSession/ChatMessage is compared by
// default instead of being silently ignored.

// Session fields the transcript does not render. `branchSwitchBlocked` is the reviewer-activity gate
// WorkspacePage mirrors onto the Session (already ignored here before this module existed);
// `updatedAt` is bumped on every chunk, and is only rendered by surfaces outside the transcript (the
// sidebar reads the live store; the Session info card shows it as of the last structural change).
// `activities` / `activityGroups` arrive several times a turn (every tool event, plus every status change)
// and are rendered by the list container's own subscription (see activity-subscription) — comparing them
// here re-minted the panel's props on every tool event, which re-rendered the panel, the list container and
// the panel chrome with it (measured: nine icons for one update, eight of them unrelated to it).
const IGNORED_SESSION_KEYS = new Set([
  'branchSwitchBlocked',
  'messages',
  'updatedAt',
  'activities',
  'activityGroups'
])

// Message fields a chunk may write for the message it is streaming into.
const STREAMED_MESSAGE_KEYS = new Set(['content', 'updatedAt', 'eventIds'])

const hasSameOwnFields = (
  previous: object,
  next: object,
  ignoredKeys: ReadonlySet<string>
): boolean => {
  const previousFields = previous as Record<string, unknown>
  const nextFields = next as Record<string, unknown>
  const previousKeys = Object.keys(previousFields).filter((key) => !ignoredKeys.has(key))
  const nextKeys = Object.keys(nextFields).filter((key) => !ignoredKeys.has(key))
  if (previousKeys.length !== nextKeys.length) return false

  return previousKeys.every(
    (key) => Object.hasOwn(nextFields, key) && Object.is(previousFields[key], nextFields[key])
  )
}

// True only for the one message a run is streaming into, and only when the text is all that moved.
// Anything else about that message — its status leaving `streaming`, a new image, a tool activity being
// attached — is structure, and must re-render.
const differsOnlyByStreamedText = (previous: ChatMessage, next: ChatMessage): boolean => {
  if (previous.role !== 'agent' || next.role !== 'agent') return false
  if (previous.status !== 'streaming' || next.status !== 'streaming') return false

  return hasSameOwnFields(previous, next, STREAMED_MESSAGE_KEYS)
}

// Whether re-rendering a container with `next` could produce anything different from `previous`.
export const carriesSameTranscriptStructure = (
  previous: ChatSession | undefined,
  next: ChatSession | undefined
): boolean => {
  if (Object.is(previous, next)) return true
  if (!previous || !next) return false
  if (!hasSameOwnFields(previous, next, IGNORED_SESSION_KEYS)) return false

  const previousMessages = previous.messages
  const nextMessages = next.messages
  if (previousMessages === nextMessages) return true
  if (!previousMessages || !nextMessages) return false
  if (previousMessages.length !== nextMessages.length) return false

  for (let index = 0; index < previousMessages.length; index += 1) {
    const previousMessage = previousMessages[index]
    const nextMessage = nextMessages[index]
    // Settled turns keep their instance across chunks, so this is the common case and it is free.
    if (Object.is(previousMessage, nextMessage)) continue
    if (!previousMessage || !nextMessage) return false
    if (!differsOnlyByStreamedText(previousMessage, nextMessage)) return false
  }

  return true
}

// The list-level form of the same question, for the workspace's subscription to the session list: a chunk
// may only move text, so a list where every session is either the same instance or a chunk of one is
// "nothing new to render".
export const carriesSameSessionListStructure = (
  previous: readonly ChatSession[],
  next: readonly ChatSession[]
): boolean => {
  if (previous === next) return true
  if (previous.length !== next.length) return false

  for (let index = 0; index < previous.length; index += 1) {
    if (!carriesSameTranscriptStructure(previous[index], next[index])) return false
  }

  return true
}
