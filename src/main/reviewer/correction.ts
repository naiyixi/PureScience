// Auditor correction: after a review with warn/fail findings completes,
// injects one [Auditor] message into the main session.
//
// Phase 3: correction.ts no longer hardcodes unaddressed resolutions.
// The fix loop in orchestrator.ts drives re-review and sets resolutions from those results.

import type { ReviewerAcpRuntime } from './acp-runtime'
import { createLogger } from '../logger'
import type { AcpPromptRequest } from '../../shared/acp'
import type { ReviewCheck } from '../../shared/reviewer'

const log = createLogger('reviewer:correction')

// Builds the [Auditor] message body per design.md §6:
//
//   [Auditor] A fresh-context reviewer traced your work and found N issues:
//     1. [fail] "<claim>"  — <evidence>
//     2. [warn] ...
//   Acknowledge in one line and make the fix (or rebut in one line if a finding is wrong). Don't restate or narrate your evaluation.
export const buildAuditorMessage = (checks: ReviewCheck[]): string => {
  const n = checks.length
  const issueWord = n === 1 ? 'issue' : 'issues'
  const header = `[Auditor] A fresh-context reviewer traced your work and found ${n} ${issueWord}:`

  const lines = checks.map((c, i) => {
    const num = i + 1
    return `  ${num}. [${c.status}] "${c.claim}"  — ${c.evidence}`
  })

  const footer =
    "Acknowledge in one line and make the fix (or rebut in one line if a finding is wrong). Don't restate or narrate your evaluation."

  return [header, ...lines, footer].join('\n')
}

// Why a correction prompt never reached the main session. Named rather than collapsed into one message:
// `session-busy` means another turn was already streaming in this session (retriable in principle),
// `provenance-failed` means the message could not be attributed, and `send-failed` is the residual case.
// Measured on the real machine (2026-11-09): 19 `An ACP prompt is already running for this session`
// failures were reported as "The correction prompt failed." — the user could not tell a collision from a
// broken provider, and neither could the next investigation.
export type CorrectionFailureReason = 'session-busy' | 'provenance-failed' | 'send-failed'

const SESSION_BUSY_ERROR = 'already running for this session'

export const classifyCorrectionFailure = (message: string): CorrectionFailureReason =>
  message.includes(SESSION_BUSY_ERROR) ? 'session-busy' : 'send-failed'

// Whether this call put a correction turn on the wire, or stepped aside for one that was already
// running in the same main session.
//
// Why single-flight rather than a retry: the measured collision (2026-11-09, two review lanes over
// the same session) is not a transient provider fault — both lanes wanted to inject a nearly
// identical [Auditor] message, and the loser's prompt turned into `An ACP prompt is already running
// for this session` plus its checks marked unaddressed. Waiting for the running turn and then
// re-reviewing it is the honest answer: the session gets ONE correction, and the second lane judges
// its own checks against that correction's output.
export type CorrectionInjectionResult =
  | { kind: 'injected' }
  | { kind: 'no-findings' }
  | { kind: 'deferred'; waitedOn: 'completed' | 'failed' | 'still-in-flight' }

type InFlightCorrection = Promise<'completed' | 'failed'>

// How many times a caller will wait for the running turn and retry the slot after a failed send.
// Small by design: a third lane waiting behind two failures is a symptom, not a queue.
const MAX_DEFERRAL_HOPS = 3

// Keyed by the MAIN session id: that is the resource a correction turn occupies. Module-level
// because the reviewers that inject are started from several places in the main process; the
// alternative (threading a registry through every caller) makes the guard skippable.
const inFlightCorrections = new Map<string, InFlightCorrection>()

// Injects the [Auditor] message into the main session and waits for the correction turn to complete.
// At most ONE correction turn runs per main session: a call that arrives while another one is on the
// wire waits for it and reports `{ kind: 'deferred' }` instead of colliding with it.
// Resolution updates are NOT performed here — Phase 3 orchestrator drives re-review and sets
// resolutions from the re-review outcome.
//
// Errors are isolated: a failed correction is logged but does NOT crash the review lifecycle.
export const injectAuditorMessage = async (options: {
  sessionId: string
  mainSessionId: string
  findings: ReviewCheck[] // the full checks list; only warn/fail are injected
  acpRuntime: ReviewerAcpRuntime
  provenanceContext: NonNullable<AcpPromptRequest['provenanceContext']>
  // Optional hook for tests to capture the injected message text.
  onCorrectionPrompt?: (text: string) => void
  // Called if the correction sendPrompt fails, so the caller can undo pre-emptive suppression and say
  // WHY in the persisted disposition.
  onCorrectionFailed?: (reason: CorrectionFailureReason) => void
}): Promise<CorrectionInjectionResult> => {
  const {
    sessionId,
    mainSessionId,
    findings,
    acpRuntime,
    provenanceContext,
    onCorrectionPrompt,
    onCorrectionFailed
  } = options

  // Only inject for warn/fail checks.
  const warnFailChecks = findings.filter((c) => c.status === 'warn' || c.status === 'fail')
  if (warnFailChecks.length === 0) {
    log.info('no warn/fail checks; skipping auditor injection', { sessionId })
    return { kind: 'no-findings' }
  }

  const message = buildAuditorMessage(warnFailChecks)

  log.info('injecting [Auditor] message into main session', {
    sessionId,
    mainSessionId,
    findingCount: warnFailChecks.length
  })

  // Single-flight, resolved SYNCHRONOUSLY (a lookup followed by a registration with no await in
  // between), so two lanes arriving in the same turn cannot both pass the check.
  let waitedOnFailure = false
  for (let attempt = 0; attempt <= MAX_DEFERRAL_HOPS; attempt += 1) {
    const inFlight = inFlightCorrections.get(mainSessionId)
    if (!inFlight) break
    if (attempt === MAX_DEFERRAL_HOPS) {
      return { kind: 'deferred', waitedOn: waitedOnFailure ? 'failed' : 'still-in-flight' }
    }
    log.info(
      '[Auditor] correction deferred: another correction turn is already in flight for this session',
      { sessionId, mainSessionId, findingCount: warnFailChecks.length }
    )
    const outcome = await inFlight
    if (outcome === 'completed') {
      // The other lane's turn is the correction this session got. Its own re-review is what judges
      // that text; this lane re-reviews the same correction turn instead of stacking a second one.
      return { kind: 'deferred', waitedOn: 'completed' }
    }
    // The other lane's send failed, so the session still needs a correction: take the slot. The
    // owning call's own `finally` may not have run yet, so release the settled-and-failed entry
    // here — waiting on a dead flight would just burn the retry budget.
    waitedOnFailure = true
    if (inFlightCorrections.get(mainSessionId) === inFlight) {
      inFlightCorrections.delete(mainSessionId)
    }
  }

  // Notify test hooks (if any).
  onCorrectionPrompt?.(message)

  const turn: InFlightCorrection = (async () => {
    try {
      // Inject through the main-session sendPrompt path (design.md cross-cutting requirement).
      // This is a normal prompt turn that the user sees in the conversation.
      await acpRuntime.sendPrompt({ sessionId: mainSessionId, text: message, provenanceContext })
      log.info('[Auditor] correction turn complete', { mainSessionId })
      return 'completed' as const
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      const reason = classifyCorrectionFailure(errorMsg)
      log.error('[Auditor] correction sendPrompt failed', {
        mainSessionId,
        reason,
        error: errorMsg
      })
      // Error handling: a failed correction does NOT spin into a re-review loop.
      // The correction turn never produced a stop, so undo the pre-emptive auto-review suppression.
      onCorrectionFailed?.(reason)
      return 'failed' as const
    }
  })()
  inFlightCorrections.set(mainSessionId, turn)
  try {
    await turn
  } finally {
    if (inFlightCorrections.get(mainSessionId) === turn) {
      inFlightCorrections.delete(mainSessionId)
    }
  }
  return { kind: 'injected' }
}
