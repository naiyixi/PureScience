import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'

import { describe, expect, it, vi } from 'vitest'

import type { ClaudeInstallEvent } from '../../shared/settings'
import { installHermesWithPipx, pipxCandidates, resolvePipxPath } from './hermes-install'
import type { HermesPipxSpawn } from './hermes-install'

// A pipx here is a scripted child process, not a shebang script on disk: a `#!/bin/sh` fixture runs on
// the macOS and Linux lanes but cannot be executed at all on Windows (no shebang resolution), which is
// exactly how this file turned the Windows lane red with `ok: false` / `exitCode: undefined`. Driving
// the child directly keeps every assertion below — real pipx output, its own exit code, the kill at the
// deadline, a spawn failure — checkable on every lane.

class FakeChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  kill = vi.fn((): boolean => true)
}

type Script = {
  stdout?: string
  stderr?: string
  exitCode?: number | null
  spawnError?: Error
  // Never closes on its own: the installer's deadline is the only thing that ends it.
  hang?: boolean
}

const scriptedSpawn = (
  script: Script
): {
  child: FakeChild
  spawnImpl: HermesPipxSpawn
  calls: { command: string; args: string[]; env: NodeJS.ProcessEnv }[]
} => {
  const child = new FakeChild()
  const calls: { command: string; args: string[]; env: NodeJS.ProcessEnv }[] = []

  const spawnImpl: HermesPipxSpawn = (command, args, options) => {
    calls.push({ command, args, env: options.env })

    setImmediate(() => {
      if (script.spawnError) {
        child.emit('error', script.spawnError)
        return
      }
      if (script.hang) return
      if (script.stdout) child.stdout.emit('data', Buffer.from(script.stdout))
      if (script.stderr) child.stderr.emit('data', Buffer.from(script.stderr))
      child.emit('close', script.exitCode ?? 0)
    })

    return child as unknown as ChildProcess
  }

  return { child, spawnImpl, calls }
}

const collect = (): { events: ClaudeInstallEvent[]; onEvent: (e: ClaudeInstallEvent) => void } => {
  const events: ClaudeInstallEvent[] = []
  return { events, onEvent: (event) => events.push(event) }
}

describe('hermes pipx installer', () => {
  it('reports a missing pipx with the two commands that fix it, and changes nothing', async () => {
    const { events } = collect()
    const result = await installHermesWithPipx({
      installId: 'i1',
      pipxPath: null,
      onEvent: () => {}
    })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('pipx was not found')
    expect(result.error).toContain('brew install pipx')
    expect(result.error).toContain('python3 -m pip install --user pipx')
    // A missing installer must not pretend to have started: no progress event is emitted.
    expect(events).toHaveLength(0)
  })

  it('runs exactly `pipx install hermes-agent` in the caller environment', async () => {
    const { spawnImpl, calls } = scriptedSpawn({ exitCode: 0 })

    await installHermesWithPipx({
      installId: 'i2',
      pipxPath: '/fake/bin/pipx',
      onEvent: () => {},
      env: { PIPX_HOME: '/fake/pipx-home' },
      spawnImpl
    })

    expect(calls).toHaveLength(1)
    expect(calls[0].command).toBe('/fake/bin/pipx')
    expect(calls[0].args).toEqual(['install', 'hermes-agent'])
    // The caller's env survives, pip's version nag is silenced, and the inherited env is not dropped.
    expect(calls[0].env.PIPX_HOME).toBe('/fake/pipx-home')
    expect(calls[0].env.PIP_DISABLE_PIP_VERSION_CHECK).toBe('1')
    expect(calls[0].env.PATH).toBe(process.env.PATH)
  })

  it('streams pipx output while it runs and succeeds on exit 0', async () => {
    const { events, onEvent } = collect()
    const { spawnImpl } = scriptedSpawn({
      stdout: 'installing hermes-agent\n',
      stderr: 'done\n',
      exitCode: 0
    })

    const result = await installHermesWithPipx({
      installId: 'i3',
      pipxPath: '/fake/bin/pipx',
      onEvent,
      spawnImpl
    })

    expect(result).toMatchObject({ ok: true, exitCode: 0 })
    const streams = events.filter((event) => event.kind === 'log').map((event) => event.stream)
    expect(streams).toContain('stdout')
    expect(streams).toContain('stderr')
    // pipx has no byte accounting, so exactly one phase tick is expected — not a fabricated percentage.
    const progress = events.filter((event) => event.kind === 'progress')
    expect(progress).toHaveLength(1)
    expect(progress[0]).toMatchObject({ phase: 'installing' })
  })

  it('surfaces pipx own last lines when it exits non-zero, instead of a generic message', async () => {
    const { onEvent } = collect()
    const { spawnImpl } = scriptedSpawn({
      stderr: 'error: no matching distribution found\n',
      exitCode: 3
    })

    const result = await installHermesWithPipx({
      installId: 'i4',
      pipxPath: '/fake/bin/pipx',
      onEvent,
      spawnImpl
    })

    expect(result.ok).toBe(false)
    expect(result.exitCode).toBe(3)
    expect(result.error).toContain('no matching distribution found')
  })

  it('stops a hung pipx at the deadline, says it was stopped, and kills it', async () => {
    const { child, spawnImpl } = scriptedSpawn({ hang: true })

    const result = await installHermesWithPipx({
      installId: 'i5',
      pipxPath: '/fake/bin/pipx',
      onEvent: () => {},
      timeoutMs: 250,
      spawnImpl
    })

    expect(result.ok).toBe(false)
    expect(result.timedOut).toBe(true)
    expect(result.error).toContain('did not finish')
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('reports a spawn failure as its own message, with no exit code to report', async () => {
    // This is the shape a Windows lane produced: the installer file existed but the OS could not start
    // it. It must read as "could not start", never as a silent success or a made-up exit code.
    const { spawnImpl } = scriptedSpawn({ spawnError: new Error('spawn EACCES') })

    const result = await installHermesWithPipx({
      installId: 'i6',
      pipxPath: '/fake/bin/pipx',
      onEvent: () => {},
      spawnImpl
    })

    expect(result.ok).toBe(false)
    expect(result.exitCode).toBeUndefined()
    expect(result.error).toContain('spawn EACCES')
  })
})

describe('hermes pipx lookup', () => {
  it('tries the well-known Unix spots before anything on PATH', () => {
    const candidates = pipxCandidates({
      platform: 'linux',
      homePath: '/home/tester',
      env: { PATH: '/usr/bin:/home/tester/.local/bin' }
    })

    expect(candidates.slice(0, 4)).toEqual([
      '/home/tester/.local/bin/pipx',
      '/opt/homebrew/bin/pipx',
      '/usr/local/bin/pipx',
      '/home/tester/.pyenv/shims/pipx'
    ])
    expect(candidates).toContain('/usr/bin/pipx')
  })

  it('looks for the Windows shim spellings under the Windows script dirs', () => {
    const candidates = pipxCandidates({
      platform: 'win32',
      homePath: 'C:\\Users\\tester',
      env: {
        APPDATA: 'C:\\Users\\tester\\AppData\\Roaming',
        LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local',
        PATH: 'C:\\Windows\\System32;C:\\Users\\tester\\AppData\\Roaming\\Python\\Scripts'
      }
    })

    // `pip install --user pipx` lands here, and only the extension spellings are startable on Windows.
    expect(candidates[0]).toBe('C:\\Users\\tester\\AppData\\Roaming\\Python\\Scripts\\pipx.exe')
    expect(candidates[1]).toBe('C:\\Users\\tester\\AppData\\Roaming\\Python\\Scripts\\pipx.cmd')
    expect(candidates).toContain(
      'C:\\Users\\tester\\AppData\\Local\\pipx\\venvs\\pipx\\Scripts\\pipx.exe'
    )
    // PATH is split on the Windows delimiter, not `:`.
    expect(candidates).toContain('C:\\Windows\\System32\\pipx.exe')
    expect(candidates.every((candidate) => !candidate.startsWith('C:\\Windows\\System32;C:'))).toBe(
      true
    )
  })

  it('returns the first candidate that exists, and null when none does', () => {
    // Every assertion below names the platform explicitly: `resolvePipxPath` defaults to the host, so an
    // assertion against a bare default would be a POSIX-only test (homebrew paths do not exist on Windows).
    expect(resolvePipxPath(() => false)).toBeNull()
    const posix = { platform: 'darwin' as const, homePath: '/home/tester', env: { PATH: '' } }
    expect(resolvePipxPath((candidate) => candidate === '/opt/homebrew/bin/pipx', posix)).toBe(
      '/opt/homebrew/bin/pipx'
    )
    // First match wins: the pyenv shim is later in the probe order than `~/.local/bin`.
    expect(resolvePipxPath((candidate) => candidate.includes('pipx'), posix)).toBe(
      '/home/tester/.local/bin/pipx'
    )
    expect(
      resolvePipxPath(
        (candidate) =>
          candidate === 'C:\\Users\\tester\\AppData\\Roaming\\Python\\Scripts\\pipx.exe',
        {
          platform: 'win32',
          env: { APPDATA: 'C:\\Users\\tester\\AppData\\Roaming', PATH: '' }
        }
      )
    ).toBe('C:\\Users\\tester\\AppData\\Roaming\\Python\\Scripts\\pipx.exe')
  })
})
