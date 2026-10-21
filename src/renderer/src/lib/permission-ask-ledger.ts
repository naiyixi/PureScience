import { useSyncExternalStore } from 'react'

import type { AcpPermissionRequest } from '../../../shared/acp'

/**
 * How many approval cards this conversation actually put in front of the reader — counted in the
 * renderer, from the cards it rendered.
 *
 * Why a renderer-side count exists at all: the main process logs every permission request it
 * receives (`permission request received`), but most of those never become a card — the broker
 * resolves them itself (an automatic option, or a remembered grant) before it publishes anything to
 * the window. A log-based number therefore reads as "the user was asked 2,128 times" when the user
 * was asked a few dozen times at most. The only honest source for "how often was I interrupted" is
 * the surface that interrupts: the card. This module is that count.
 *
 * Boundary: it measures *cards*, not *decisions the user made* — a card that the reader never
 * answered (the turn was cancelled, the profile changed and the broker resolved it) still happened,
 * and is still counted, because it did cost the reader a look. It is in-memory for the running
 * renderer only; nothing here is persisted, and a restart starts at zero (the readout is a session
 * readout, not a historical record).
 */

export type PermissionAskSummary = {
  readonly sessionId: string
  /** Cards shown for this session, counted once per request id. */
  readonly asked: number
  /** Distinct tool identities among those cards. */
  readonly distinct: number
  /**
   * Cards whose tool identity had already been asked about earlier in this session — the part of
   * the density that a session-scope grant on the first ask would have removed.
   */
  readonly repeated: number
}

type SessionLedger = {
  readonly requestIds: Set<string>
  readonly keyCounts: Map<string, number>
  summary: PermissionAskSummary
}

/**
 * Bounded so a long-running window cannot accumulate sessions forever. Oldest-inserted is dropped
 * first; a dropped session simply starts counting again if it comes back (documented, not silent:
 * the readout's own number is per-session and re-derived).
 */
const MAX_TRACKED_SESSIONS = 64

const ledgers = new Map<string, SessionLedger>()
const listeners = new Set<() => void>()

const notify = (): void => {
  for (const listener of Array.from(listeners)) listener()
}

/**
 * The identity two cards must share to be "the same thing asked twice".
 *
 * MCP identity (`server/tool`) is the broker's own display identity, so it is preferred; then the
 * provider tool name; then the tool kind. `title` is the last resort because providers write it, and
 * it is the only field that may be absent — a request without any of these is counted as an ask but
 * is never reported as a repeat, since "same" would then be a guess.
 */
export const permissionAskKey = (request: AcpPermissionRequest): string | undefined => {
  const candidate = request.mcpIdentity ?? request.providerToolName ?? request.toolKind
  if (typeof candidate !== 'string') return undefined
  const normalized = candidate.trim().toLowerCase()
  return normalized.length > 0 ? normalized : undefined
}

/** Test hook: forget every session. Production code never calls this. */
export const resetPermissionAskLedger = (): void => {
  ledgers.clear()
  notify()
}

const summaryFor = (
  sessionId: string,
  requestIds: Set<string>,
  keyCounts: Map<string, number>
): PermissionAskSummary => {
  let repeated = 0
  for (const count of keyCounts.values()) repeated += Math.max(0, count - 1)
  return Object.freeze({
    sessionId,
    asked: requestIds.size,
    distinct: keyCounts.size,
    repeated
  })
}

/**
 * Records one card as presented. Idempotent per request id: re-rendering the same card must not
 * inflate the count (React re-renders the approval surface on every runtime snapshot).
 *
 * @param request - the request whose card is on screen
 * @returns true when this call recorded a request the ledger had not seen yet
 */
export const recordPresentedPermissionRequest = (request: AcpPermissionRequest): boolean => {
  const sessionId = request.sessionId
  if (!sessionId || !request.requestId) return false

  let ledger = ledgers.get(sessionId)
  if (!ledger) {
    if (ledgers.size >= MAX_TRACKED_SESSIONS) {
      const oldest = ledgers.keys().next()
      if (!oldest.done) ledgers.delete(oldest.value)
    }
    ledger = {
      requestIds: new Set<string>(),
      keyCounts: new Map<string, number>(),
      summary: Object.freeze({ sessionId, asked: 0, distinct: 0, repeated: 0 })
    }
    ledgers.set(sessionId, ledger)
  }

  if (ledger.requestIds.has(request.requestId)) return false
  ledger.requestIds.add(request.requestId)

  const key = permissionAskKey(request)
  if (key) ledger.keyCounts.set(key, (ledger.keyCounts.get(key) ?? 0) + 1)

  ledger.summary = summaryFor(sessionId, ledger.requestIds, ledger.keyCounts)
  notify()
  return true
}

/**
 * The session's readout, or undefined before its first card.
 *
 * The returned object keeps its identity until the count changes, which is what
 * `useSyncExternalStore` requires — a fresh object per call would re-render forever.
 */
export const readPermissionAskSummary = (
  sessionId: string | undefined
): PermissionAskSummary | undefined => {
  if (!sessionId) return undefined
  return ledgers.get(sessionId)?.summary
}

export const subscribePermissionAskLedger = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Live readout for the visible session; stable identity between changes. */
export const usePermissionAskSummary = (
  sessionId: string | undefined
): PermissionAskSummary | undefined =>
  useSyncExternalStore(
    subscribePermissionAskLedger,
    () => readPermissionAskSummary(sessionId),
    () => undefined
  )
