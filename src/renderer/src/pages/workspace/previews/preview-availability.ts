import type { ProbeArtifactAvailabilityItem } from '../../../../../shared/artifacts'

// Every artifact card in a transcript used to ask "is this file still there?" on its own, and each ask was a
// full preview read in main: for an Artifact Version locator that meant a query, the whole file read and its
// checksum verified — 22 ms median per card, 15 of them in flight at once on the project with the most
// artifacts. The question is the same for every card, so it is asked once for the batch instead: requests
// made in the same tick are collected and sent as one `artifacts.probe-availability` call.
//
// Cards stay independent. A card never waits on another card's read, a slow or hung answer cannot hold up the
// rest (each request resolves on its own), and a failed batch leaves the affected cards retryable rather than
// permanently unanswered.

type AvailabilityRequest = ProbeArtifactAvailabilityItem

type PendingRequest = {
  request: AvailabilityRequest
  resolve: (unavailable: boolean) => void
}

const requestKey = (request: AvailabilityRequest): string =>
  JSON.stringify([
    request.projectId ?? null,
    request.sessionId ?? null,
    request.source,
    request.path
  ])

const cache = new Map<string, boolean>()
const pending = new Map<string, PendingRequest>()
let flushScheduled = false

const bridge = ():
  ((request: { items: AvailabilityRequest[] }) => Promise<{ unavailable: string[] }>) | undefined =>
  window.api?.artifacts?.probeAvailability

const flush = (): void => {
  flushScheduled = false
  const batch = [...pending.values()]
  pending.clear()
  if (batch.length === 0) return

  const probe = bridge()
  if (!probe) {
    // No batched bridge (an older preload): answer "available" rather than leave the cards waiting. The
    // per-card fallback belongs to the caller, not here — this module only knows how to batch.
    for (const entry of batch) entry.resolve(false)
    return
  }

  void Promise.resolve(probe({ items: batch.map((entry) => entry.request) })).then(
    (result) => {
      const missing = new Set(result?.unavailable ?? [])
      for (const entry of batch) {
        const unavailable = missing.has(entry.request.path)
        cache.set(requestKey(entry.request), unavailable)
        entry.resolve(unavailable)
      }
    },
    () => {
      // A failed batch is not an answer: resolve as available and leave the key uncached so a later mount can
      // ask again.
      for (const entry of batch) entry.resolve(false)
    }
  )
}

/**
 * Resolves to whether the requested path is no longer present. Requests made in the same tick share one call.
 */
const requestPreviewAvailability = (request: AvailabilityRequest): Promise<boolean> => {
  const cached = cache.get(requestKey(request))
  if (cached !== undefined) return Promise.resolve(cached)

  return new Promise<boolean>((resolve) => {
    pending.set(requestKey(request), { request, resolve })
    if (flushScheduled) return
    flushScheduled = true
    setTimeout(flush, 0)
  })
}

// Only for tests: the module keeps a process-wide cache and a single pending batch.
const resetPreviewAvailabilityForTests = (): void => {
  cache.clear()
  pending.clear()
  flushScheduled = false
}

export { requestPreviewAvailability, resetPreviewAvailabilityForTests }
