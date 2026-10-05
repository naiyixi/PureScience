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
// window's user-initiated cancel so the two cannot drift apart:
//   - 'slurm': cancelled through the scheduler (scancel), which owns the process tree;
//   - direct SSH: SIGTERM then SIGKILL on the recorded pid.
// Best-effort by construction: every branch ends in `true` so a process that already exited is not
// reported to the caller as a failed cancellation.
export const buildRemoteKillCommand = (handle: RemoteHandle): string =>
  handle.kind === 'slurm' && handle.slurm_job_id
    ? `scancel ${handle.slurm_job_id} 2>/dev/null; true`
    : `kill ${handle.pid ?? ''} 2>/dev/null; kill -9 ${handle.pid ?? ''} 2>/dev/null; true`

// Per-job kill budget. Same 10s the poller's fallback kill uses: the command itself returns
// immediately, so a longer wait only delays the answer for a host that is not answering.
export const REMOTE_KILL_TIMEOUT_MS = 10_000

// Output budget for the kill command. It prints nothing; the cap only bounds what a shell banner
// could add to the result.
export const REMOTE_KILL_MAX_OUTPUT_BYTES = 64
