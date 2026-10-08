import type { RemoteHandle } from './job-dispatcher'

// Parses the persisted `remote_handle` JSON of a compute job. Absent or malformed ⇒ null, which the
// callers read as "there is no remote process to address" — never as "the process was stopped".
export const parseRemoteHandle = (raw: string | undefined): RemoteHandle | null => {
  if (!raw) return null
  try {
    return JSON.parse(raw) as RemoteHandle
  } catch {
    return null
  }
}

// The one stop command for a remote job handle, shared by the poller's fallback timeout and the
// window's user-initiated cancel (IC39) so the two cannot drift apart:
//   - 'slurm': cancelled through the scheduler (scancel), which owns the process tree;
//   - direct SSH: SIGTERM then SIGKILL on the job's process group, then on the recorded pid.
//
// The group is addressed first because the dispatcher launches the launcher detached (setsid), which
// makes the recorded pid the job's session and process-group leader: measured on a live host, killing
// the pid alone stops the launcher and leaves the workload (`timeout` → login shell → command) running.
// The pid forms stay for a host that could not detach (no setsid, no perl) where the negative form is
// an ESRCH no-op. Both signals are best-effort and every branch is silenced, so a process that already
// exited is not reported to the caller as a failed cancellation.
export const buildRemoteKillCommand = (handle: RemoteHandle): string => {
  if (handle.kind === 'slurm' && handle.slurm_job_id) {
    return `scancel ${handle.slurm_job_id} 2>/dev/null; true`
  }
  // No pid: there is nothing to address, and inventing a bare `kill -` would address the *shell's*
  // last job. The command still ends in `true` — the caller reads "nothing to stop", not "stop failed".
  const pid = Number.isFinite(handle.pid) ? String(handle.pid) : ''
  const attempts = pid
    ? [
        `kill -TERM -${pid} 2>/dev/null`,
        `kill -TERM ${pid} 2>/dev/null`,
        `kill -KILL -${pid} 2>/dev/null`,
        `kill -KILL ${pid} 2>/dev/null`
      ]
    : []
  return [...attempts, 'true'].join('; ')
}

// Per-job kill budget. Same 10s the poller's fallback kill uses: the command itself returns
// immediately, so a longer wait only delays the answer for a host that is not answering.
export const REMOTE_KILL_TIMEOUT_MS = 10_000

// Did the kill actually reach the host? The SSH runner reports a transport failure as a *result*, not
// as a rejection: `SystemSshRunner.run` resolves with ssh's own exit code (255 = the connection never
// opened) plus a `timedOut` flag, and only resolves with exitCode null when ssh could not be spawned.
// Reading only a thrown error is how a live run caught the window claiming "Stop requested — the job
// is now cancelled." — and writing the row `cancelled` — for a host it never reached. The command ends
// in `true`, so a delivered kill exits 0; anything else (255, another non-zero code, no status, or the
// budget elapsing) is a delivery this caller must not claim.
export const killDeliveryFailed = (result: {
  exitCode: number | null
  timedOut: boolean
}): boolean => result.timedOut || result.exitCode !== 0

// One sentence naming what was observed, shown verbatim beneath the window's own wording so the user
// reads a fact (the exit status and ssh's own message) rather than a restatement of the refusal.
export const describeKillDeliveryFailure = (
  result: { exitCode: number | null; stderr: string; timedOut: boolean },
  alias: string
): string => {
  if (result.timedOut) {
    return `The stop command to "${alias}" did not answer within ${REMOTE_KILL_TIMEOUT_MS / 1000} seconds.`
  }
  const firstLine = (
    result.stderr
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line !== '') ?? ''
  ).slice(0, 240)
  const status = result.exitCode === null ? 'no exit status' : `exit code ${result.exitCode}`
  return firstLine === ''
    ? `The stop command to "${alias}" failed (${status}).`
    : `The stop command to "${alias}" failed (${status}): ${firstLine}`
}

// Output budget for the kill command. It prints nothing; the cap only bounds what a shell banner
// could add to the result.
export const REMOTE_KILL_MAX_OUTPUT_BYTES = 64
