export type ApplicationShutdownTrigger = 'quit' | 'update' | 'migration-relaunch'

let requestedTrigger: ApplicationShutdownTrigger = 'quit'

// Records the reason for the next orderly app shutdown. The returned rollback is used when the API
// that was expected to initiate quitting throws synchronously and the current process stays alive.
export const markApplicationShutdownTrigger = (
  trigger: Exclude<ApplicationShutdownTrigger, 'quit'>
): (() => void) => {
  requestedTrigger = trigger
  return () => {
    if (requestedTrigger === trigger) requestedTrigger = 'quit'
  }
}

export const currentApplicationShutdownTrigger = (): ApplicationShutdownTrigger => requestedTrigger

// Set while an orderly shutdown of this process has been requested (before-quit ran) and not yet cancelled.
// A notebook kernel that dies while this is set was cut off by the app going away (quit, or an external
// termination that asked the app to quit), so its run is the domain's interruption — NOT a failure, because
// the cell's code may have been fine. A quit the user cancels clears it again, so a kernel that genuinely
// dies with the app staying up is still recorded as a crash.
let shutdownRequested = false

export const markApplicationShutdownRequested = (): void => {
  shutdownRequested = true
}

export const clearApplicationShutdownRequested = (): void => {
  shutdownRequested = false
}

export const isApplicationShutdownRequested = (): boolean => shutdownRequested

export const clearApplicationShutdownTrigger = (): void => {
  requestedTrigger = 'quit'
}
