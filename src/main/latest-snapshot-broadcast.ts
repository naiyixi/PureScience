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
//
// One shape over the window machine: a request carries the build, and the build runs only when the window
// actually delivers. That is the shape the coordinator wants, because *producing* the value is what costs:
// the aggregate state snapshot is a filter + map + sort over the whole event log of every runtime
// (0.5–0.9 ms measured during streaming), emitted up to ~80 times per second against ~7 sends per second.
// Building the snapshots that the window then throws away was the majority of that cost. Collapsing after
// the build cannot recover it; collapsing before it does, and the renderer receives exactly the same
// snapshots at exactly the same moments.

export type SnapshotBroadcastOptions = {
  // How long a burst is collapsed before the newest snapshot goes out.
  windowMs?: number
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void
}

// The window state machine, shared by both shapes so the delivery moments cannot drift apart.
const createLatestCoalescer = <Payload>(
  deliver: (payload: Payload) => void,
  options: SnapshotBroadcastOptions = {}
): ((payload: Payload) => void) => {
  const windowMs = options.windowMs ?? 150
  const now = options.now ?? Date.now
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle))

  let windowStartedAt: number | undefined
  let pending: Payload | undefined
  let flushHandle: ReturnType<typeof setTimeout> | undefined

  const flush = (): void => {
    flushHandle = undefined
    const payload = pending
    pending = undefined
    windowStartedAt = payload === undefined ? undefined : now()
    if (payload !== undefined) deliver(payload)
  }

  return (payload: Payload): void => {
    const windowStart = windowStartedAt
    const elapsed = windowStart === undefined ? Number.POSITIVE_INFINITY : now() - windowStart
    if (elapsed >= windowMs) {
      // Nothing recent: deliver now and open a window for whatever follows.
      windowStartedAt = now()
      pending = undefined
      if (flushHandle !== undefined) {
        clearTimer(flushHandle)
        flushHandle = undefined
      }
      deliver(payload)
      return
    }

    // Inside the window: keep the newest and let the trailing flush carry it.
    pending = payload
    if (flushHandle === undefined) {
      flushHandle = setTimer(flush, Math.max(0, (windowStart ?? 0) + windowMs - now()))
    }
  }
}

// Returns a requester that builds at most one snapshot per window: the newest request's build is the one
// that gets delivered. Requests inside a window replace each other without building anything.
export const createDeferredSnapshotBroadcast = <Snapshot>(
  send: (snapshot: Snapshot) => void,
  options: SnapshotBroadcastOptions = {}
): ((build: () => Snapshot) => void) =>
  createLatestCoalescer<() => Snapshot>((build) => send(build()), options)
