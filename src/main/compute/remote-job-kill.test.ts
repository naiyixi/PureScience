import { describe, expect, it } from 'vitest'

import type { RemoteHandle } from './job-dispatcher'
import {
  buildRemoteKillCommand,
  describeKillDeliveryFailure,
  killDeliveryFailed,
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

  it('terminates a direct-SSH launch by process group first, SIGTERM then SIGKILL', () => {
    // The launcher is launched detached, so the recorded pid is the job's session/process-group
    // leader: the group form is what actually stops the workload (measured on a live host — the pid
    // form alone leaves `timeout` → login shell → command running).
    expect(buildRemoteKillCommand(handle({ pid: 4242 }))).toBe(
      'kill -TERM -4242 2>/dev/null; kill -TERM 4242 2>/dev/null; ' +
        'kill -KILL -4242 2>/dev/null; kill -KILL 4242 2>/dev/null; true'
    )
  })

  it('addresses nothing when the pid is unknown, and still ends in a successful no-op', () => {
    // Best-effort by construction: the caller must not be told a kill failed just because the process
    // had already exited. With no pid there is nothing to aim at — a bare `kill -` would aim at the
    // remote shell's own last job, so no kill attempt is emitted at all.
    const cmd = buildRemoteKillCommand(handle({ kind: 'pid', pid: undefined }))
    expect(cmd).toBe('true')
    expect(cmd).not.toContain('kill -')
  })

  it('keeps the kill budget bounded', () => {
    // The command returns immediately, so a long wait only delays the answer for a silent host.
    expect(REMOTE_KILL_TIMEOUT_MS).toBe(10_000)
    expect(REMOTE_KILL_MAX_OUTPUT_BYTES).toBe(64)
  })
})

// The delivery reading exists because the SSH runner reports a transport failure as a result, not as a
// rejection. A caller that reads only a thrown error claims a stop it never delivered — measured on a
// live host, where the window said the job was cancelled while the kill had gone nowhere.
describe('killDeliveryFailed', () => {
  it('accepts a delivered kill', () => {
    expect(killDeliveryFailed({ exitCode: 0, timedOut: false })).toBe(false)
  })

  it('rejects ssh failing to open the connection (exit 255)', () => {
    expect(killDeliveryFailed({ exitCode: 255, timedOut: false })).toBe(true)
  })

  it('rejects any non-zero exit, a missing status, and a round-trip abandoned at the budget', () => {
    for (const result of [
      { exitCode: 1, timedOut: false },
      { exitCode: null, timedOut: false },
      { exitCode: null, timedOut: true },
      { exitCode: 0, timedOut: true }
    ]) {
      expect(killDeliveryFailed(result), JSON.stringify(result)).toBe(true)
    }
  })
})

describe('describeKillDeliveryFailure', () => {
  it('names the alias, the exit status and the message ssh reported', () => {
    const detail = describeKillDeliveryFailure(
      {
        exitCode: 255,
        stderr: 'ssh: connect to host 127.0.0.1 port 2222: Connection refused',
        timedOut: false
      },
      '127.0.0.1'
    )
    expect(detail).toContain('"127.0.0.1"')
    expect(detail).toContain('exit code 255')
    expect(detail).toContain('Connection refused')
  })

  it('skips blank stderr lines and states the budget when the round-trip timed out', () => {
    expect(
      describeKillDeliveryFailure({ exitCode: 255, stderr: '\n\n  \n', timedOut: false }, 'hpc')
    ).toBe('The stop command to "hpc" failed (exit code 255).')
    expect(
      describeKillDeliveryFailure({ exitCode: null, stderr: '', timedOut: true }, 'hpc')
    ).toContain('did not answer within 10 seconds')
  })
})
