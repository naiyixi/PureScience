// The read model search answers from, kept between queries.
//
// Every search used to load and parse every session file, which is why a query over a real corpus took
// more than a second. Sessions only change when they are written, and the durable repository already
// knows when that happens, so this keeps the parsed sessions and re-reads only when that signal moves.
//
// The time-to-live is a floor under correctness rather than a cache policy: the signal covers writes made
// by this process, and a session written by another process on the same data root is picked up within it.

import type { PersistedChatSession } from '../../shared/session-persistence'

export const SESSION_INDEX_DEFAULT_TTL_MS = 30_000

export type SessionIndexDeps = {
  loadAll: () => Promise<PersistedChatSession[]>
  // Bumped by the durable repository on every session write.
  revision: () => number
  now?: () => number
  ttlMs?: number
}

export type SessionIndexStats = {
  // How many times the sessions were actually read.
  reads: number
  // How many queries were answered from what was already in hand.
  hits: number
  sessions: number
}

export type SessionIndex = {
  getSessions: () => Promise<PersistedChatSession[]>
  stats: () => SessionIndexStats
  // Drops the cached view, so the next read is fresh. Used by tests and by a caller that has just written.
  invalidate: () => void
}

export const createSessionIndex = (deps: SessionIndexDeps): SessionIndex => {
  const now = deps.now ?? (() => Date.now())
  const ttlMs = deps.ttlMs ?? SESSION_INDEX_DEFAULT_TTL_MS

  let cached: PersistedChatSession[] | undefined
  let cachedRevision = -1
  let cachedAt = 0
  let inFlight: Promise<PersistedChatSession[]> | undefined
  let reads = 0
  let hits = 0

  const read = async (): Promise<PersistedChatSession[]> => {
    // One read at a time: a burst of queries on a cold cache waits for the same read instead of each
    // starting its own.
    if (!inFlight) {
      reads += 1
      inFlight = deps
        .loadAll()
        .then((sessions) => {
          cached = sessions
          cachedRevision = deps.revision()
          cachedAt = now()
          return sessions
        })
        .finally(() => {
          inFlight = undefined
        })
    }
    return inFlight
  }

  return {
    async getSessions() {
      const fresh = cached !== undefined && cachedRevision === deps.revision()
      const withinTtl = now() - cachedAt < ttlMs
      if (fresh && withinTtl && !inFlight) {
        hits += 1
        return cached as PersistedChatSession[]
      }
      return read()
    },
    stats: () => ({ reads, hits, sessions: cached?.length ?? 0 }),
    invalidate: () => {
      cached = undefined
      cachedRevision = -1
      cachedAt = 0
    }
  }
}
