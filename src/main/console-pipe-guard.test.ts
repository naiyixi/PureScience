import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { createConsolePipeGuard } from './console-pipe-guard'
import { createLogger, flushLogs, initLogger, suppressConsoleMirror } from './logger'

// The streams here are the same shape the guard sees in production (an emitter with `on`), which is all it
// is allowed to depend on. `EventEmitter` is used rather than a hand-rolled stub so the listener accounting
// this file asserts on is real.

const emitter = (): EventEmitter => new EventEmitter()

const pipeError = (code: string, message = `write ${code}`): Error =>
  Object.assign(new Error(message), { code })

describe('console pipe guard', () => {
  it('turns a stream error into one named report instead of a process-level failure', () => {
    const stdout = emitter()
    const stderr = emitter()
    const reports: unknown[] = []
    const guard = createConsolePipeGuard({
      stdout,
      stderr,
      onPipeClosed: (failure) => reports.push(failure)
    })
    guard.install()

    // Before the fix this emit had no listener at all, so Node re-raised it as `uncaughtException`
    // (`write EPIPE`, frame `afterWriteDispatched`) — one record per mirrored log line.
    expect(() => stdout.emit('error', pipeError('EPIPE'))).not.toThrow()

    expect(reports).toEqual([{ stream: 'stdout', code: 'EPIPE', message: 'write EPIPE' }])
    expect(guard.isBroken('stdout')).toBe(true)
    expect(guard.isBroken('stderr')).toBe(false)
  })

  it('reports a burst on one stream exactly once — it is one fact, not N', () => {
    const stdout = emitter()
    const reports: unknown[] = []
    const guard = createConsolePipeGuard({
      stdout,
      stderr: emitter(),
      onPipeClosed: (failure) => reports.push(failure)
    })
    guard.install()

    for (let attempt = 0; attempt < 54; attempt += 1) {
      stdout.emit('error', pipeError('EPIPE'))
    }

    expect(reports).toHaveLength(1)
  })

  it('names an error that carries no code instead of dropping it', () => {
    const stderr = emitter()
    const reports: Array<{ stream: string; code: string; message: string }> = []
    const guard = createConsolePipeGuard({
      stdout: emitter(),
      stderr,
      onPipeClosed: (failure) => reports.push(failure)
    })
    guard.install()

    stderr.emit('error', new Error('socket closed with no code'))

    expect(reports).toEqual([
      { stream: 'stderr', code: 'no-code', message: 'socket closed with no code' }
    ])
  })

  it('stops trusting a stream after any error, not just EPIPE', () => {
    const stderr = emitter()
    const reports: Array<{ stream: string; code: string; message: string }> = []
    const guard = createConsolePipeGuard({
      stdout: emitter(),
      stderr,
      onPipeClosed: (failure) => reports.push(failure)
    })
    guard.install()

    // A broken pipe answers `EIO`, an already-destroyed stream `ERR_STREAM_DESTROYED`; neither is worth
    // writing to again, so every stream error marks the stream and the first one is what gets reported.
    stderr.emit('error', pipeError('EIO', 'write EIO'))
    stderr.emit(
      'error',
      pipeError('ERR_STREAM_DESTROYED', 'Cannot call write after a stream was destroyed')
    )

    expect(reports).toEqual([{ stream: 'stderr', code: 'EIO', message: 'write EIO' }])
    expect(guard.isBroken('stderr')).toBe(true)
  })

  it('does not stack listeners when installed twice', () => {
    const stdout = emitter()
    const reports: unknown[] = []
    const guard = createConsolePipeGuard({
      stdout,
      stderr: emitter(),
      onPipeClosed: (failure) => reports.push(failure)
    })
    guard.install()
    guard.install()

    expect(stdout.listenerCount('error')).toBe(1)
    stdout.emit('error', pipeError('EPIPE'))
    expect(reports).toHaveLength(1)
  })

  it('keeps two independent guards independent on the same streams', () => {
    const stdout = emitter()
    const first: unknown[] = []
    const second: unknown[] = []
    createConsolePipeGuard({
      stdout,
      stderr: emitter(),
      onPipeClosed: (failure) => first.push(failure)
    }).install()
    createConsolePipeGuard({
      stdout,
      stderr: emitter(),
      onPipeClosed: (failure) => second.push(failure)
    }).install()

    stdout.emit('error', pipeError('EPIPE'))

    expect(first).toHaveLength(1)
    expect(second).toHaveLength(1)
  })
})

describe('console mirror suppression', () => {
  const dirs: string[] = []

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
    vi.restoreAllMocks()
  })

  it('stops console output for the rest of the process while file records continue', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ps-console-mirror-'))
    dirs.push(dir)
    initLogger({ logDir: dir, fileName: 'main.log', mirrorToConsole: true })
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const log = createLogger('console-pipe-guard-test')

    log.warn('before the pipe died', { step: 1 })
    expect(consoleWarn).toHaveBeenCalledTimes(1)

    suppressConsoleMirror()
    log.warn('after the pipe died', { step: 2 })
    expect(consoleWarn).toHaveBeenCalledTimes(1)

    await flushLogs()
    const written = await readFile(join(dir, 'main.log'), 'utf8')
    // Both records survive on disk: suppression removes the console copy, never the file one.
    expect(written).toContain('before the pipe died')
    expect(written).toContain('after the pipe died')
  })
})

// The unit tests above assert the guard's own bookkeeping. This one asserts the mechanism it exists for, on
// a real pipe: with a reader that goes away, an unhandled `error` on `process.stdout` becomes a
// process-level `uncaughtException`, and a listener (exactly what the guard installs) prevents it. Without
// this arm, "the guard works" would only mean "the guard matches its own stub".
describe('a closed console reader on a real pipe', () => {
  const dirs: string[] = []

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  const runArm = async (installListener: boolean): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), 'ps-pipe-arm-'))
    dirs.push(dir)
    const out = join(dir, 'out.txt')
    await writeFile(out, '')
    const script = [
      "const fs = require('node:fs')",
      `const out = ${JSON.stringify(out)}`,
      "process.on('uncaughtException', (e) => { fs.appendFileSync(out, 'UNCAUGHT ' + e.code + '\\n'); process.exit(0) })",
      ...(installListener
        ? [
            "process.stdout.on('error', (e) => { fs.appendFileSync(out, 'PIPE-ERROR ' + e.code + '\\n'); process.exit(0) })"
          ]
        : []),
      'setInterval(() => { process.stdout.write("x".repeat(4096) + "\\n") }, 5)',
      "setTimeout(() => { fs.appendFileSync(out, 'NO-FAILURE\\n'); process.exit(0) }, 8000)"
    ].join('\n')

    const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'] })
    // Drop the reader the way a terminal or supervisor does: the writing end keeps its descriptor.
    await new Promise((resolve) => setTimeout(resolve, 250))
    child.stdout?.destroy()

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        resolve()
      }, 6000)
      child.on('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
    return readFile(out, 'utf8')
  }

  it('is an uncaught exception without a listener and is not one with it', async () => {
    const unguarded = await runArm(false)
    const guarded = await runArm(true)

    expect(unguarded).toContain('UNCAUGHT EPIPE')
    expect(guarded).toContain('PIPE-ERROR EPIPE')
    expect(guarded).not.toContain('UNCAUGHT')
  }, 30_000)
})
