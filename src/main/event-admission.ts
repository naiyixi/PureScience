// Bounded admission gate for high-volume renderer event streams.
//
// Agent turns can emit tens of thousands of fine-grained events (thoughts, tool progress,
// message chunks). Broadcasting every one over IPC freezes the renderer; the snapshot channel
// (acp:state) and the event stream already reconcile, so the gate drops excess *transient*
// events inside a window while always admitting terminal/authoritative ones (stop, error,
// artifact claims, permissions, plans). Dropping is fail-safe: the renderer never depends on a
// specific transient event, only on the bounded stream staying responsive.

import type { AcpRuntimeEvent, AcpRuntimeEventKind } from '../shared/acp'

// Events the renderer must never miss: lifecycle terminals and state-bearing signals. Everything
// else is classed as transient (high-frequency, reconcilable from the snapshot).
const ALWAYS_ADMIT: ReadonlySet<AcpRuntimeEventKind> = new Set<AcpRuntimeEventKind>([
  'stop',
  'error',
  'artifact',
  'permission',
  'plan',
  'message' // chunked text is coalesced by the renderer; keep it flowing at a bounded rate
])

export type BoundedEventAdmissionOptions = {
  // How long a batch window stays open before flushing.
  windowMs?: number
  // Max events broadcast per window. Excess transient events inside the window are dropped.
  maxPerWindow?: number
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void
}

// Returns a closed-over broadcast that batches transient events and always admits critical ones.
export const createBoundedEventAdmission = (
  broadcast: (event: AcpRuntimeEvent) => void,
  options: BoundedEventAdmissionOptions = {}
): ((event: AcpRuntimeEvent) => void) => {
  const windowMs = options.windowMs ?? 16
  const maxPerWindow = options.maxPerWindow ?? 200
  const now = options.now ?? Date.now
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle))

  let windowStart = 0
  let emittedInWindow = 0
  let droppedInWindow = 0
  let flushHandle: ReturnType<typeof setTimeout> | undefined

  const flush = (): void => {
    flushHandle = undefined
    windowStart = 0
    emittedInWindow = 0
    droppedInWindow = 0
  }

  return (event: AcpRuntimeEvent): void => {
    const isCritical = ALWAYS_ADMIT.has(event.kind)
    const elapsed = now() - windowStart

    if (windowStart === 0 || elapsed >= windowMs) {
      // Open a fresh window; critical events always pass, transients start with a clean budget.
      windowStart = now()
      emittedInWindow = 0
      droppedInWindow = 0
      if (flushHandle !== undefined) {
        clearTimer(flushHandle)
        flushHandle = undefined
      }
      if (!isCritical) {
        // Arm the flush so the budget resets even when no critical event arrives.
        flushHandle = setTimer(flush, windowMs) as ReturnType<typeof setTimeout>
      }
      emittedInWindow += 1
      broadcast(event)
      return
    }

    if (isCritical) {
      // Critical events bypass the budget but keep the window open.
      broadcast(event)
      return
    }

    if (emittedInWindow < maxPerWindow) {
      emittedInWindow += 1
      broadcast(event)
      return
    }
    // Budget exhausted: drop this transient event (fail-safe; snapshot reconciles).
    droppedInWindow += 1
  }
}
