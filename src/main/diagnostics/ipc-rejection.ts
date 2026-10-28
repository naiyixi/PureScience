import type { CallerContext } from '../caller-context'
import { diagnosticErrorFields, type Logger } from '../logger'
import { cpuAttributionFields, type CpuUsageSample } from './cpu-attribution'
import { heldSplitForMonotonicWindow, sharedLoopHeldWindows } from './loop-held-windows'

type IpcRejectionLogger = Pick<Logger, 'warn'>

// Above this, a successful IPC handler is worth a log line. The renderer's session/file calls do NOT go
// through the application-command router (they are Electron IPC), so this is the only place a first-open
// cost can be attributed in main. Chosen below the 130-430 ms first-open hitches and above ordinary reads.
const SLOW_IPC_HANDLER_THRESHOLD_MS = 50

type IpcRejectionDiagnosticInput<T> = {
  channel: string
  callerContext: Pick<CallerContext, 'surface' | 'location' | 'principalKind' | 'actionOrigin'>
  invoke: () => T | PromiseLike<T>
  log: IpcRejectionLogger
  now?: () => number
  // How much of [startMs, endMs] the process was not running at all (loop-stall windows). Defaults to the
  // shared registry the watchdog writes; tests inject their own answer.
  heldMs?: (startMs: number, endMs: number) => number
  // How far back those windows are complete. The ring drops its oldest entries, so a long handler can start
  // before the retained coverage; without this the line would call that window "loop free". Defaults to the
  // shared registry, injected only by tests.
  heldCoverageStartMs?: () => number | undefined
  // Process CPU around the same window, so a slow handler can say whether the time was ours or the process
  // was not running (see `cpu-attribution`). Injected only by tests.
  cpuUsage?: () => CpuUsageSample
}

const safeNow = (now: () => number): number => {
  try {
    const value = now()
    return Number.isFinite(value) ? value : 0
  } catch {
    return 0
  }
}

const safeHeldMs = (
  source: (startMs: number, endMs: number) => number,
  startMs: number,
  endMs: number
): number => {
  try {
    const value = source(startMs, endMs)
    return Number.isFinite(value) ? value : 0
  } catch {
    // A diagnostic must never replace the handler's result; an unknown split stays a plain duration.
    return 0
  }
}

/**
 * Adds the universal rejected-request floor around an IPC invocation.
 *
 * This adapter deliberately has no access to the request arguments or result. Its entire diagnostic
 * vocabulary is fixed caller metadata plus a coarse error category, and all diagnostic work is
 * best-effort so it can never replace the handler's authoritative result or rejection.
 */
export const invokeWithIpcRejectionDiagnostics = <T>(
  input: IpcRejectionDiagnosticInput<T>
): T | PromiseLike<T> => {
  const now = input.now ?? performance.now.bind(performance)
  const heldMsWithin =
    input.heldMs ??
    ((startMs: number, endMs: number): number => sharedLoopHeldWindows.heldMsWithin(startMs, endMs))
  const heldCoverageStartMs =
    input.heldCoverageStartMs ?? ((): number | undefined => sharedLoopHeldWindows.coverageStartMs())
  const startedAt = safeNow(now)
  const cpuUsage = input.cpuUsage ?? ((): CpuUsageSample => process.cpuUsage())
  const cpuStart = cpuUsage()
  const recordRejection = (error: unknown): void => {
    try {
      input.log.warn('ipc handler rejected', {
        channel: input.channel,
        surface: input.callerContext.surface,
        location: input.callerContext.location,
        principalKind: input.callerContext.principalKind,
        actionOrigin: input.callerContext.actionOrigin,
        durationMs: Math.max(0, safeNow(now) - startedAt),
        ...diagnosticErrorFields(error)
      })
    } catch {
      // Diagnostic failures must never replace the handler's original rejection.
    }
  }

  // Best-effort, and deliberately carries no request arguments or result: this adapter never sees them.
  const recordSlowSuccess = (): void => {
    try {
      const endedAt = safeNow(now)
      const durationMs = Math.max(0, endedAt - startedAt)
      if (durationMs < SLOW_IPC_HANDLER_THRESHOLD_MS) return
      // Split the wall duration by the same windows the stall watchdog reports. A settings-mount burst where
      // five channels all finish together is one blocked loop, not five slow handlers: without this split
      // every one of them reads as app work and the next round optimizes a channel that did nothing.
      const held = heldSplitForMonotonicWindow(startedAt, endedAt, durationMs, {
        // Guarded here rather than in the shared helper: a source that throws must still leave the line with
        // its duration, which is what `safeHeldMs` did at this call site before the arithmetic moved.
        heldMsWithin: (startMs: number, endMs: number): number =>
          safeHeldMs(heldMsWithin, startMs, endMs),
        coverageStartMs: heldCoverageStartMs
      })
      input.log.warn('ipc handler was slow', {
        channel: input.channel,
        surface: input.callerContext.surface,
        location: input.callerContext.location,
        durationMs,
        // Was this window ours? The held split above says how much of the wall time the loop was not running;
        // this says what the process actually consumed. Five channels finishing together after a settings
        // mount read as five slow handlers before, and the CPU share is what separates "we worked for 21 s"
        // from "we were suspended for 21 s" without the next reader having to guess.
        ...cpuAttributionFields(cpuStart, cpuUsage(), durationMs),
        // Present only when there is something to split, so an ordinary slow handler's line is unchanged.
        ...(held ?? {})
      })
    } catch {
      // Diagnostic failures must never replace the handler's authoritative result.
    }
  }

  try {
    const result = input.invoke()
    if (result !== null && (typeof result === 'object' || typeof result === 'function')) {
      const then = (result as { then?: unknown }).then
      if (typeof then !== 'function') {
        recordSlowSuccess()
        return result
      }

      // Promise.resolve(result) would read a thenable's `then` getter a second time. Assimilate the
      // cached function on a microtask instead, matching native timing while preserving one-shot or
      // side-effectful thenables and their authoritative rejection value.
      const assimilated = new Promise<T>((resolve, reject) => {
        queueMicrotask(() => {
          try {
            // Log on the way in rather than by chaining another .then: no extra microtask hop, and the
            // value the caller receives is unchanged.
            Reflect.apply(then, result, [
              (value: T) => {
                recordSlowSuccess()
                resolve(value)
              },
              reject
            ])
          } catch (error) {
            reject(error)
          }
        })
      })
      return assimilated.catch((error: unknown) => {
        recordRejection(error)
        throw error
      })
    }
    // Anything that is not an object or function (a string, a number, a boolean, null) lands here, so the
    // timing has to be reported on this path too — the sync case fell through it untimed before this test.
    recordSlowSuccess()
    return result
  } catch (error) {
    recordRejection(error)
    throw error
  }
}

export type { IpcRejectionDiagnosticInput, IpcRejectionLogger }
