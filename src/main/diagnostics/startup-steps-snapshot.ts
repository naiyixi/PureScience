// Where the startup composition's breakdown waits for the support bundle.
//
// Why a holder at all: `createComposeStepRecorder` is a local inside the composition root (`ipc.ts`), while a
// support bundle is assembled from a different call path — minutes or hours later, when the user reports that
// the app "takes forever to start". Passing the recorder through would mean threading it through every layer
// between the two; the alternative of re-deriving the breakdown from the log was rejected on purpose: a parser
// over one log line reports *nothing* the first time that line's shape changes, and "nothing" reads exactly
// like "startup was fine". `stall-record-ring` is kept the same way, for the same reason.
//
// The absent state is named rather than left as an empty list: a bundle exported before composition closed
// carries `status: 'not-recorded'` with the reason, so no reader can mistake it for "startup took no time".

import type { ComposeStepsSnapshot } from './compose-steps'

export type StartupStepsSummary =
  | Readonly<
      ComposeStepsSnapshot & {
        status: 'recorded'
      }
    >
  | Readonly<{
      status: 'not-recorded'
      /** Only one reason exists today, and naming it keeps the field from growing silently. */
      reason: 'composition-not-finished'
    }>

export type StartupStepsHolder = {
  /** Called once, where the composition window closes. Overwrites: the newest window is the one a report asks about. */
  record: (snapshot: ComposeStepsSnapshot) => void
  summary: () => StartupStepsSummary
  /** Test seam: forget everything without rebuilding the holder. */
  clear: () => void
}

export const createStartupStepsHolder = (): StartupStepsHolder => {
  let recorded: ComposeStepsSnapshot | undefined
  return {
    record: (snapshot): void => {
      recorded = snapshot
    },
    summary: (): StartupStepsSummary =>
      recorded
        ? { status: 'recorded', ...recorded }
        : { status: 'not-recorded', reason: 'composition-not-finished' },
    clear: (): void => {
      recorded = undefined
    }
  }
}

/**
 * The one holder the composition root writes and the support bundle reads. A second instance would be a second
 * truth about the same startup — the failure mode is a bundle that always says `not-recorded` while the log
 * shows the steps.
 */
export const sharedStartupSteps: StartupStepsHolder = createStartupStepsHolder()
