// Revision buckets for the transcript. The scroller rebuilds its grouping on every streaming chunk (the
// conversation graph changes with each one), which would hand every message slot a fresh array each time
// and defeat the message item's memoisation. Reusing a bucket whose contents did not change keeps the
// identity stable for settled messages while still reflecting edits to the ones that did change.

export type RevisionCandidate = {
  id: string
  createdAt: number
  role: string
  revisionRootMessageId?: string
}

const isSameBucket = <T extends { id: string }>(
  previous: readonly T[] | undefined,
  next: readonly T[]
): previous is readonly T[] =>
  previous !== undefined &&
  previous.length === next.length &&
  previous.every((message, index) => message === next[index])

// The buckets are arrays the caller only reads from; they are mutable here so a bucket can be built and
// sorted before it is either kept or replaced by the cached instance.
export const groupRevisionsByRoot = <T extends RevisionCandidate>(
  messages: readonly T[],
  previous?: ReadonlyMap<string, readonly T[]>
): Map<string, T[]> => {
  const grouped = new Map<string, T[]>()

  for (const message of messages) {
    if (message.role !== 'user' || !message.revisionRootMessageId) continue
    const rootId = message.revisionRootMessageId
    const bucket = grouped.get(rootId)
    if (bucket) bucket.push(message)
    else grouped.set(rootId, [message])
  }

  for (const [rootId, bucket] of grouped) {
    bucket.sort(
      (left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id)
    )
    // An unchanged bucket is handed back as the same array, so slots keyed on it keep their identity.
    const cached = previous?.get(rootId)
    if (isSameBucket(cached, bucket)) {
      // The cached array is handed back as-is — that identity is the whole point. It is only read from
      // (findIndex / index access in the transcript), so widening it to the map's mutable array type is
      // safe here.
      grouped.set(rootId, cached as T[])
    }
  }

  return grouped
}
