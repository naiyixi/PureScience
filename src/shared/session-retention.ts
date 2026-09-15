// Draft for src/shared/session-retention.ts (apply after the running suite finishes).
//
// A conversation that runs for months keeps every message it ever exchanged, and the file behind it
// grows without limit: loading it, hashing it, packaging it and shipping it all get slower forever.
// The reference implementation bounds this. Ours did not.
//
// The rule here is deliberately narrow and always recorded:
//   * only the *oldest* messages are dropped, and only beyond the limit;
//   * the drop is returned, not just performed, so the document can say what it lost —
//     a trimmed history that pretends to be complete is worse than a large one;
//   * nothing here deletes anything by itself: callers decide where to apply it.
export const MAX_RETAINED_SESSION_MESSAGES = 5_000

/** What a trimmed history lost. Absent means nothing was dropped. */
export type SessionRetention = {
  /** How many of the oldest messages are no longer in the document. */
  droppedMessages: number
  /** Creation time of the oldest message still present: everything before it is gone, so the gap is
   *  datable and a reader can see where the record resumes. */
  droppedBefore: number
}

/**
 * Reads a retention record back off a document. A hand-edited file must not be able to claim drops
 * that never happened, so only a positive integer count with a finite boundary survives.
 */
export const sanitizeSessionRetention = (value: unknown): SessionRetention | undefined => {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as { droppedMessages?: unknown; droppedBefore?: unknown }
  const droppedMessages = candidate.droppedMessages
  const droppedBefore = candidate.droppedBefore
  if (
    typeof droppedMessages !== 'number' ||
    !Number.isFinite(droppedMessages) ||
    droppedMessages <= 0
  ) {
    return undefined
  }
  if (typeof droppedBefore !== 'number' || !Number.isFinite(droppedBefore)) return undefined
  return { droppedMessages: Math.floor(droppedMessages), droppedBefore }
}

export const trimSessionHistory = <Message extends { createdAt: number }>(
  messages: readonly Message[],
  limit: number = MAX_RETAINED_SESSION_MESSAGES
): { messages: Message[]; retention: SessionRetention | undefined } => {
  if (limit <= 0 || messages.length <= limit) {
    return { messages: [...messages], retention: undefined }
  }
  const retained = messages.slice(messages.length - limit)
  const dropped = messages.slice(0, messages.length - limit)
  return {
    messages: retained,
    retention: {
      droppedMessages: dropped.length,
      droppedBefore: retained[0]?.createdAt ?? dropped[dropped.length - 1].createdAt
    }
  }
}
