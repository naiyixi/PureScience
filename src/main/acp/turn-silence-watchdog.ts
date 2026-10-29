// Turn silence watchdog (2026-10-29 incident).
//
// A prompt turn is a conversation with a runtime process: we dispatch, then wait for events. Nothing in the
// app bounded that wait, so a runtime that accepted the prompt and then said nothing left the session
// `running` — measured: 15+ minutes of a spinner with zero acp events, and the record still `running` after a
// restart. The status had to be cleared by hand.
//
// This is the missing bound, and it is deliberately at the EVENT level, not the request level: a long turn
// that keeps streaming thoughts, tool calls or text is healthy and must never be cut. Only total silence —
// no event at all for `timeoutMs` — is treated as a hang.
//
// The registry is keyed by app session id because the two ends live in different places: the turn boundary
// (prompt-turn-workflow) arms and disarms, and the provider notification funnel (routeNotification) touches.
// Keeping the state in one map means there is no second bookkeeping of "which turn is live" to drift.

export const TURN_SILENCE_TIMEOUT_MS = 10 * 60 * 1000

/** The reason put on the abort: it is what the surface shows, so it has to name the measurement. */
export const TURN_SILENT_ABORT_MESSAGE =
  'The runtime accepted this prompt and then produced no events for 10 minutes, so the turn was stopped. ' +
  'The backend is likely hung — switch backend or send the request again.'

type TimerHandle = ReturnType<typeof setTimeout>

export type TurnSilenceWatchdogClock = {
  now?: () => number
  schedule?: (run: () => void, ms: number) => TimerHandle
  cancel?: (handle: TimerHandle) => void
}

export type TurnSilenceWatchdog = {
  /** Restart the clock (called when the turn is dispatched). */
  arm: () => void
  /** Any inbound event from the runtime resets the clock. */
  touch: () => void
  /** The turn ended (by any route) — the clock must not fire afterwards. */
  disarm: () => void
  /** Milliseconds since the last event, or undefined when the watchdog is not armed. */
  silentForMs: () => number | undefined
}

export const createTurnSilenceWatchdog = (
  onSilent: (silentForMs: number) => void,
  options: TurnSilenceWatchdogClock & { timeoutMs?: number } = {}
): TurnSilenceWatchdog => {
  const now = options.now ?? (() => Date.now())
  const schedule = options.schedule ?? ((run, ms) => setTimeout(run, ms))
  const cancel = options.cancel ?? ((handle) => clearTimeout(handle))
  const timeoutMs = options.timeoutMs ?? TURN_SILENCE_TIMEOUT_MS

  let handle: TimerHandle | undefined
  let lastEventAt: number | undefined

  const clear = (): void => {
    if (handle !== undefined) cancel(handle)
    handle = undefined
  }

  const armTimer = (): void => {
    clear()
    handle = schedule(() => {
      handle = undefined
      const silentFor = lastEventAt === undefined ? 0 : now() - lastEventAt
      // Only fire once per armed turn: the callback is expected to end the turn, and a second fire would
      // name a reason for a turn that no longer exists.
      lastEventAt = undefined
      onSilent(silentFor)
    }, timeoutMs)
  }

  return {
    arm: () => {
      lastEventAt = now()
      armTimer()
    },
    touch: () => {
      if (lastEventAt === undefined) return
      lastEventAt = now()
      armTimer()
    },
    disarm: () => {
      lastEventAt = undefined
      clear()
    },
    silentForMs: () => (lastEventAt === undefined ? undefined : now() - lastEventAt)
  }
}

const armed = new Map<string, TurnSilenceWatchdog>()

/** Arms the watchdog for one session. A second arm replaces the first (a new turn supersedes the old one). */
export const armTurnSilenceWatchdog = (
  sessionId: string,
  onSilent: (silentForMs: number) => void,
  options: TurnSilenceWatchdogClock & { timeoutMs?: number } = {}
): void => {
  armed.get(sessionId)?.disarm()
  const watchdog = createTurnSilenceWatchdog(onSilent, options)
  armed.set(sessionId, watchdog)
  watchdog.arm()
}

export const touchTurnSilenceWatchdog = (sessionId: string): void => {
  armed.get(sessionId)?.touch()
}

export const disarmTurnSilenceWatchdog = (sessionId: string): void => {
  const watchdog = armed.get(sessionId)
  if (!watchdog) return
  watchdog.disarm()
  armed.delete(sessionId)
}

/** Test seam: how long this session's turn has been silent, or undefined when nothing is armed. */
export const silentForMs = (sessionId: string): number | undefined =>
  armed.get(sessionId)?.silentForMs()
