// The message-centre card for a background result that could not be delivered (IC40).
//
// A blocked delivery is recorded in its session's ledger, which makes it invisible to anyone who is not
// looking at that conversation — and the session it belongs to is exactly the thing that may be
// unreadable. This card is the one surface that is not inside a session.
//
// The wording is canonical English rather than localised here: the inbox persists it, and the renderer
// maps it to the interface language at render time. That is the contract `Task completed` and the
// migrated `Previous task update` card already use, and it is what keeps a card written yesterday
// readable after the language is switched today. The named reason stays in the ledger, which is
// localised per write (`background-delivery-labels.ts`), so it is deliberately not repeated here.
import type { BackgroundDelivery } from '../../shared/background-delivery'
import {
  BACKGROUND_RESULT_NEEDS_ATTENTION_SUMMARY,
  BACKGROUND_RESULT_NEEDS_ATTENTION_TITLE
} from '../../shared/notifications'

export type NeedsAttentionNotificationRecord = Readonly<{
  dedupeKey: string
  kind: 'task.needs-attention'
  source: 'compute'
  projectId: string
  sessionId: string
  originId: string
  title: string
  summary: string
}>

// One card per ledger row: the row's id is the identity, so every later pass over the same delivery
// builds the same key and the inbox turns the repeat into a no-op instead of a second card. The state is
// deliberately not part of the key — a row that is reported and then delivered again must not produce a
// second card.
export const buildNeedsAttentionNotification = (
  delivery: Pick<BackgroundDelivery, 'id' | 'sessionId' | 'projectId' | 'jobId'>
): NeedsAttentionNotificationRecord => ({
  dedupeKey: `task.needs-attention:${delivery.sessionId}:${delivery.id}`,
  kind: 'task.needs-attention',
  source: 'compute',
  projectId: delivery.projectId,
  sessionId: delivery.sessionId,
  originId: delivery.jobId,
  title: BACKGROUND_RESULT_NEEDS_ATTENTION_TITLE,
  summary: BACKGROUND_RESULT_NEEDS_ATTENTION_SUMMARY
})
