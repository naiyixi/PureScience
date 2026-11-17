import type { UpdateStrategy } from './strategy'

const SIX_HOURS_MS = 6 * 60 * 60 * 1000

// A failed background check is retried soon, because both ways it fails on a laptop are transient. The one
// that matters is the wake-up: every timer that came due while the machine slept fires the moment it
// resumes, so the check starts before the network stack is back and dies on `net::ERR_NETWORK_CHANGED`
// (measured: a dev instance checking every six hours — 22:06 cleared, 04:06 cleared, 10:10 failed 0.3 s
// after a 1,071 s whole-process freeze, and the same slot failed on nine other days). A flat six-hour timer
// makes that first attempt final for the rest of the day, so a machine that sleeps nightly can never
// discover an update. A captive portal or a flapping link fails the same way and is worth the same retry.
const RETRY_BASE_MS = 60_000
const RETRY_MAX_MS = 15 * 60_000

// A check that never resolves must not be the end of automatic updates: the chain schedules the next
// attempt after the previous one *finishes*, so one hung attempt would otherwise silence the scheduler for
// the life of the process. Five minutes is far beyond any strategy's own deadline (the manifest flow gives
// the fetch ten seconds) and only matters when something is wrong.
const CHECK_GUARD_MS = 5 * 60_000

export type UpdateSchedulerRetry = { baseMs: number; maxMs: number }

const DEFAULT_RETRY: UpdateSchedulerRetry = { baseMs: RETRY_BASE_MS, maxMs: RETRY_MAX_MS }

// Checks once at startup, then either at `intervalMs` (after a check that produced a status) or after a
// short, doubling delay (after one that ended in `error`). The strategy swallows its own errors (status:
// error), so a failed check never becomes an uncaught rejection or nags the user; the retry is what keeps
// "failed once, before the link came back" from reading as "no update exists". Returns a stop function.
//
// The next attempt is scheduled when one finishes rather than by `setInterval`: a check can spend ten
// seconds in its own deadline, and an interval cannot know that, so a resumed machine would queue a second
// check behind the first instead of waiting for it.
export const startUpdateScheduler = (
  strategy: UpdateStrategy,
  intervalMs: number = SIX_HOURS_MS,
  retry: UpdateSchedulerRetry = DEFAULT_RETRY
): (() => void) => {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  // Set while consecutive failures are being retried; cleared by any check that produced a status other
  // than `error`, so the backoff restarts from the base delay the next time the link is gone.
  let retryDelayMs: number | undefined

  const schedule = (delayMs: number): void => {
    if (stopped) return
    timer = setTimeout(() => void run(), delayMs)
  }

  const run = async (): Promise<void> => {
    let failed = false
    let guard: ReturnType<typeof setTimeout> | undefined
    try {
      const inflight = strategy.check()
      // The guard may win this race, and a check that rejects afterwards must not surface as an unhandled
      // rejection: it is a failure this attempt has already counted.
      inflight.catch(() => undefined)
      const outcome = await Promise.race([
        inflight,
        new Promise<'timed-out'>((resolve) => {
          guard = setTimeout(() => resolve('timed-out'), CHECK_GUARD_MS)
        })
      ])
      failed = outcome === 'timed-out' || outcome.state === 'error'
    } catch {
      // A strategy that throws instead of reporting `error` is still a failed check: retry it rather than
      // letting the throw end the scheduler's chain.
      failed = true
    } finally {
      if (guard !== undefined) clearTimeout(guard)
    }
    if (stopped) return
    if (!failed) {
      retryDelayMs = undefined
      schedule(intervalMs)
      return
    }
    retryDelayMs = Math.min((retryDelayMs ?? retry.baseMs / 2) * 2, retry.maxMs)
    schedule(retryDelayMs)
  }

  void run()
  return () => {
    stopped = true
    if (timer !== undefined) clearTimeout(timer)
  }
}
