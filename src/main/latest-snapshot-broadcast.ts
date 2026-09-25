// Bounded broadcast for whole-state snapshot channels.
//
// A snapshot channel sends the complete runtime state, and the coordinator emits one on every state
// change — effectively per streamed chunk. Measured with a main-process send probe (40 chunks per turn):
// `acp:state` went out 26–40 times per turn at 7.5–30KB each (0.3–0.9MB per turn), and the payload grows
// with the session because the snapshot carries the whole event log. Every one of those messages is
// deserialized by the renderer's preload bridge, applied to React state, and (for the event log) walked in
// full again. None of that work is needed more than a few times per turn: a snapshot replaces the previous
// one, and the newest snapshot already contains every event the dropped ones carried, so a dropped
// intermediate costs nothing — it is the same "latest wins" shape as the event admission gate.
//
// First change in a window is sent immediately, so an isolated change (connect, permission, turn end) keeps
// its prompt delivery; only a burst inside the window is collapsed to its newest snapshot.

export type SnapshotBroadcastOptions = {
  // How long a burst is collapsed before the newest snapshot goes out.
  windowMs?: number
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void
}

// Returns a sender that forwards the newest snapshot at most once per window.
export const createLatestSnapshotBroadcast = <Snapshot>(
  send: (snapshot: Snapshot) => void,
  options: SnapshotBroadcastOptions = {}
): ((snapshot: Snapshot) => void) => {
  const windowMs = options.windowMs ?? 150
  const now = options.now ?? Date.now
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle))

  let windowStartedAt: number | undefined
  let pending: Snapshot | undefined
  let flushHandle: ReturnType<typeof setTimeout> | undefined

  const flush = (): void => {
    flushHandle = undefined
    const snapshot = pending
    pending = undefined
    windowStartedAt = snapshot === undefined ? undefined : now()
    if (snapshot !== undefined) send(snapshot)
  }

  return (snapshot: Snapshot): void => {
    const windowStart = windowStartedAt
    const elapsed = windowStart === undefined ? Number.POSITIVE_INFINITY : now() - windowStart
    if (elapsed >= windowMs) {
      // Nothing recent: send now and open a window for whatever follows.
      windowStartedAt = now()
      pending = undefined
      if (flushHandle !== undefined) {
        clearTimer(flushHandle)
        flushHandle = undefined
      }
      send(snapshot)
      return
    }

    // Inside the window: keep the newest and let the trailing flush carry it.
    pending = snapshot
    if (flushHandle === undefined) {
      flushHandle = setTimer(flush, Math.max(0, (windowStart ?? 0) + windowMs - now()))
    }
  }
}
