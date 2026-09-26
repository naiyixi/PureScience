import type { AcpRuntimeEvent } from '../../../../shared/acp'

// The live set a workspace runtime event processor keeps for one lane's bookkeeping.
//
// The snapshot channel only carries the events a renderer has not been sent yet (plus an overlap) — but the
// processor used to replace its live set with each incoming array, so events older than that overlap counted
// as "no longer listed": their lane was reclaimed, the processed-id ledger went with it, and the overlap
// events were then re-accepted and re-applied on every following snapshot. Measured as a regression on the
// real machine (45 streamed turns, task 91.5 → 216.5ms per turn) before this became an accumulation.
//
// Accumulating keeps what the array is for — knowing which events are still current — while an array that no
// longer lists an event stops meaning "forget the ledger". A bounded limit preserves the eviction the
// processor is written to tolerate (`A bounded source snapshot may evict this event before a slow predecessor
// finishes`), it just evicts the genuinely old rather than everything outside the newest window.

const LIVE_SET_LIMIT = 1000

export const mergeLiveEvents = (
  previous: readonly AcpRuntimeEvent[],
  incoming: readonly AcpRuntimeEvent[],
  limit = LIVE_SET_LIMIT
): AcpRuntimeEvent[] => {
  if (incoming.length === 0) return previous as AcpRuntimeEvent[]

  // Oldest first, newest last, so the bounded trim below evicts the genuinely old — an order that puts the
  // incoming events first would evict them instead of the events they supersede.
  const incomingIds = new Set(incoming.map((event) => event.id))
  const merged = previous.filter((event) => !incomingIds.has(event.id)).concat(incoming)

  return merged.length > limit ? merged.slice(merged.length - limit) : merged
}
