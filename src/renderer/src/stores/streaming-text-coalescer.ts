// Coalesces streamed text before it reaches the session store.
//
// Measured problem (docs/evidence/2026-09-25-interaction-smoothness.md): the streaming phase burns
// ~126.6ms of main-thread work per turn, and the dominant share is the streaming message's own markdown
// being re-parsed for every delta that lands. Each delta currently becomes one store update and therefore
// one render of the whole accumulated text, which is quadratic in the length of the message. Holding
// deltas for a short window turns "render once per delta" into "render once per window" without changing
// the text that finally lands.
//
// The contract this module guarantees, because streaming text must never lose or reorder a character:
//   - `push(text)` never drops text; it appends to the pending buffer in arrival order.
//   - the flush callback always receives the whole accumulated text, never a fragment.
//   - `flushNow()` makes the current text land immediately (used when the turn completes or is cancelled).
//   - once `flushNow()` has been called, no later timer can emit a second time for that batch.

export type TextCoalescerOptions = {
  // How long deltas may be held before they are handed on. Kept short enough to stay imperceptible.
  flushMs: number
  // Receives the accumulated text. Called at most once per window, and once more for an explicit flush.
  onFlush: (text: string) => void
  schedule?: (callback: () => void, delayMs: number) => number
  cancel?: (handle: number) => void
}

export type TextCoalescer = {
  push: (text: string) => void
  flushNow: () => void
  pending: () => string
}

export const createTextCoalescer = ({
  flushMs,
  onFlush,
  schedule = (callback, delayMs) => setTimeout(callback, delayMs) as unknown as number,
  cancel = (handle) => clearTimeout(handle)
}: TextCoalescerOptions): TextCoalescer => {
  let pending = ''
  let timer: number | undefined

  const clearTimer = (): void => {
    if (timer !== undefined) {
      cancel(timer)
      timer = undefined
    }
  }

  const flushNow = (): void => {
    clearTimer()
    if (pending === '') return
    const text = pending
    // The buffer is cleared before the callback so a re-entrant push during the flush starts the next
    // batch rather than being folded into the one already handed on.
    pending = ''
    onFlush(text)
  }

  const push = (text: string): void => {
    if (text === '') return
    pending += text
    if (timer !== undefined) return
    timer = schedule(() => {
      timer = undefined
      if (pending === '') return
      const flushed = pending
      pending = ''
      onFlush(flushed)
    }, flushMs)
  }

  return { push, flushNow, pending: () => pending }
}
