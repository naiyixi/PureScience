// The conversation a desktop-notification click should open. Main holds it (consume-once) until
// the renderer pulls it via 'notifications:take-pending-open-session' once its session store is
// hydrated — a push sent before the renderer's listener exists would be lost. Token uniquely
// identifies the click even when consecutive notifications target the same conversation.
export type OpenSessionFromNotificationRequest = {
  sessionId: string
  token: number
}

// Renderer-owned visibility evidence. Durable session existence comes from main's complete scan.
export type UnreadTaskViewState = {
  challengeId?: number
  visibleSessionId?: string
}

// Closed user-attention taxonomy for the message center. Application lifecycle facts such as
// Project/Session create, update, archive, restore, and delete belong to a separate activity or
// audit projection; adding them here would incorrectly give management history unread semantics.
export type NotificationKind =
  'task.completed' | 'task.needs-attention' | 'task.failed' | 'authorization.required'

export type NotificationSource =
  'agent-tool' | 'agent-question' | 'connector' | 'compute' | 'skill-import' | 'session-plan'

export type NotificationActionState = 'pending' | 'resolved' | 'rejected' | 'expired' | 'cancelled'

export type NotificationInboxItem = Readonly<{
  id: string
  sequence: number
  dedupeKey: string
  kind: NotificationKind
  source?: NotificationSource
  projectId?: string
  sessionId?: string
  originId: string
  title: string
  summary: string
  createdAt: number
  readAt?: number
  actionState?: NotificationActionState
  settledAt?: number
}>

// Canonical English wording for inbox cards whose text the renderer maps to the interface language at
// render time. Main records them, the renderer matches them, and both import from here: a card that is
// reworded on one side only would otherwise silently stop being translated on the other.
export const BACKGROUND_RESULT_NEEDS_ATTENTION_TITLE = 'Background result needs attention'
export const BACKGROUND_RESULT_NEEDS_ATTENTION_SUMMARY =
  'A finished background result could not be delivered to its conversation.'

export type NotificationInboxSnapshot = Readonly<{
  revision: number
  unreadCount: number
  latestSequence: number
  items: readonly NotificationInboxItem[]
}>

export type NotificationInboxChanged = Readonly<{
  revision: number
  unreadCount: number
  latestSequence: number
}>

export type NotificationMarkReadRequest = Readonly<{ ids: readonly string[] }>

export type NotificationMarkAllReadRequest = Readonly<{ throughSequence: number }>

export type NotificationMarkSessionCompletionsReadRequest = Readonly<{
  sessionIds: readonly string[]
}>

// Removing a card from the centre is not deleting what it points at: the conversation, project and
// anything the card was reporting all stay. Main only forgets the inbox row.
export type NotificationDeleteRequest = Readonly<{ ids: readonly string[] }>

// Clearing stops at the sequence the reader was looking at, so a notice that arrives while the
// confirmation is on screen is not swept away by an action the reader never saw it in.
export type NotificationClearRequest = Readonly<{ throughSequence: number }>
