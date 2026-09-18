import type { CallerContext } from '../caller-context'
import { diagnosticErrorFields, type Logger } from '../logger'

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
}

const safeNow = (now: () => number): number => {
  try {
    const value = now()
    return Number.isFinite(value) ? value : 0
  } catch {
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
  const startedAt = safeNow(now)
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
      const durationMs = Math.max(0, safeNow(now) - startedAt)
      if (durationMs < SLOW_IPC_HANDLER_THRESHOLD_MS) return
      input.log.warn('ipc handler was slow', {
        channel: input.channel,
        surface: input.callerContext.surface,
        location: input.callerContext.location,
        durationMs
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
