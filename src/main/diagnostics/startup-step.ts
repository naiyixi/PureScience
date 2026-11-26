// Durable record of the last application-startup step reached.
//
// Why this file exists (measured 2026-11-25/26, packaged certification on a macos-arm64 runner): four
// separate specs across three runs failed the same way — the harness waited 180 s for the app's first window, the process
// was still running, and the launch log ended at `main window created`. That tail is not evidence of where
// the process was: the log is mirrored to stdout, which is a Node stream, so everything queued behind a
// main thread that stops returning never reaches the reader. `tray creation starting` was added for
// exactly this reading on 2026-11-26 and cannot be relied on for the same reason — it is written through
// the same asynchronous sink.
//
// A synchronous write to the file descriptor does reach the reader, because it does not wait for the event
// loop. So each startup step is recorded twice: through the ordinary log (readable in a healthy launch) and
// through this marker (present even when the launch is stuck). The marker vocabulary is closed, so a reader
// never has to interpret an unfamiliar string:
//
//   window-creation-start → window-created → tray-call-start → tray-created | tray-absent | tray-failed
//
// How a stuck launch is read:
//   * last marker `window-creation-start` — the native window never came back;
//   * last marker `window-created`         — the tray call was entered and never returned (or the process
//                                            stopped between the two writes);
//   * last marker `tray-call-start`        — the status-bar item was asked for and never returned;
//   * `tray-created` present               — startup finished; a missing window at the harness is then a
//                                            delivery problem on the harness side, not a stuck main thread.

import { writeSync } from 'node:fs'

/** Values are the whole vocabulary; a step outside it cannot be recorded. */
export const STARTUP_STEPS = [
  'window-creation-start',
  'window-created',
  'tray-call-start',
  'tray-created',
  'tray-absent',
  'tray-failed'
] as const

export type StartupStep = (typeof STARTUP_STEPS)[number]

export type StartupStepRecorder = (step: StartupStep) => void

/**
 * One line per step, with the wall-clock time so a reader can tell a stall from a slow machine.
 * Exported for its own test, so the shape a stuck launch is read by is pinned rather than implied.
 */
export const formatStartupStepLine = (step: StartupStep, at: number): string =>
  `[startup-step] ${step} at ${new Date(at).toISOString()}`

/**
 * Writes the marker synchronously to stdout.
 *
 * `writeSync` on the descriptor is the point: a stream write only queues, and a main thread blocked in a
 * native call never drains that queue. Nothing here may throw — a diagnostic that cannot be written must
 * not be able to change how the application starts (a closed pipe raises EPIPE on the next write).
 */
export const writeStartupStepToStdout = (text: string): void => {
  writeSync(1, text)
}

/**
 * Builds the recorder the window lifecycle calls. `write` is injectable so tests can assert the exact
 * bytes and the failure path without touching descriptor 1.
 */
export const createStartupStepRecorder = (deps: {
  write: (text: string) => void
  now?: () => number
}): StartupStepRecorder => {
  return (step: StartupStep): void => {
    try {
      deps.write(`${formatStartupStepLine(step, deps.now?.() ?? Date.now())}\n`)
    } catch {
      // Deliberately silent: the reader of a missing marker is the failure report, and a failure to write
      // a diagnostic must never become the failure being diagnosed.
      return
    }
  }
}
