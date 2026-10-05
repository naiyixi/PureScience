import { describe, expect, it } from 'vitest'

import type { RemoteHandle } from './job-dispatcher'
import {
  buildRemoteKillCommand,
  parseRemoteHandle,
  REMOTE_KILL_MAX_OUTPUT_BYTES,
  REMOTE_KILL_TIMEOUT_MS
} from './remote-job-kill'

// The stop command is the one thing the poller's fallback timeout and the window's user-initiated
// cancel (IC39) must agree on: two copies would drift, and a drifted copy silently stops addressing
// the remote process. These cases pin the shapes both callers rely on.
const handle = (overrides: Partial<RemoteHandle> = {}): RemoteHandle => ({
  kind: 'pid',
  pid: 4242,
  exit_code_path: '/work/exit_code',
  stdout_path: '/work/stdout',
  stderr_path: '/work/stderr',
  workdir: '/work',
  ...overrides
})

describe('parseRemoteHandle', () => {
  it('reads a persisted handle', () => {
    expect(parseRemoteHandle(JSON.stringify(handle()))).toEqual(handle())
  })

  it('reads nothing as no addressable process', () => {
    expect(parseRemoteHandle(undefined)).toBeNull()
    expect(parseRemoteHandle('')).toBeNull()
  })

  it('reads a malformed handle as no addressable process rather than throwing', () => {
    expect(parseRemoteHandle('{not json')).toBeNull()
  })
})

describe('buildRemoteKillCommand', () => {
  it('cancels a scheduler job through the scheduler that owns its process tree', () => {
    expect(buildRemoteKillCommand(handle({ kind: 'slurm', slurm_job_id: 987 }))).toBe(
      'scancel 987 2>/dev/null; true'
    )
  })

  it('terminates a direct-SSH launch by pid, SIGTERM then SIGKILL', () => {
    expect(buildRemoteKillCommand(handle({ pid: 4242 }))).toBe(
      'kill 4242 2>/dev/null; kill -9 4242 2>/dev/null; true'
    )
  })

  it('still ends in a successful no-op when the pid is unknown', () => {
    // Best-effort by construction: the caller must not be told a kill failed just because the
    // process had already exited.
    expect(buildRemoteKillCommand(handle({ kind: 'pid', pid: undefined }))).toBe(
      'kill  2>/dev/null; kill -9  2>/dev/null; true'
    )
  })

  it('keeps the kill budget bounded', () => {
    // The command returns immediately, so a long wait only delays the answer for a silent host.
    expect(REMOTE_KILL_TIMEOUT_MS).toBe(10_000)
    expect(REMOTE_KILL_MAX_OUTPUT_BYTES).toBe(64)
  })
})
