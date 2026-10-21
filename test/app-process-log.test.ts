import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

import {
  appProcessLogPath,
  describeAppExit,
  launchFailureMessage,
  launchHeader,
  launchLogFileName,
  openWindowOrNameFailure,
  raceWindowAgainstExit,
  readTailLines
} from '../e2e/fixtures/app-process-log'

const identity = {
  index: 3,
  testTitle: 'certification/search-index-coverage.spec.ts > survives a restart',
  retry: 0
}

describe('launch log naming', () => {
  it('orders by launch ordinal and names the spec, so a leftover log says whose it is', () => {
    expect(launchLogFileName({ index: 12, testTitle: 'a b', retry: 0 })).toBe('012-a-b.log')
  })

  it('marks a retry so the first attempt is not mistaken for the one that passed', () => {
    expect(launchLogFileName({ index: 1, testTitle: 'x', retry: 2 })).toBe('001-x-retry2.log')
  })

  it('cuts a long title without leaving a dangling separator', () => {
    const name = launchLogFileName({ index: 7, testTitle: 'z '.repeat(80), retry: 0 })
    expect(name.startsWith('007-z-z')).toBe(true)
    expect(name.endsWith('-.log')).toBe(false)
    expect(name.length).toBeLessThanOrEqual('007-'.length + 60 + '.log'.length)
  })

  it('keeps per-launch logs in their own directory under test-results', () => {
    const path = appProcessLogPath(join(tmpdir(), 'tr'), identity)
    expect(basename(path)).toBe(launchLogFileName(identity))
    expect(basename(dirname(path))).toBe('app-process')
  })

  it('heads every log with which launch it was and which roots it was pointed at', () => {
    const header = launchHeader({
      identity,
      pid: 4242,
      startedAt: new Date('2026-10-21T00:00:00.000Z'),
      userDataRoot: '/tmp/profile',
      storageRoot: '/tmp/storage'
    })
    expect(header).toContain('launch #3')
    expect(header).toContain('retry 0')
    expect(header).toContain('pid=4242')
    expect(header).toContain('2026-10-21T00:00:00.000Z')
    expect(header).toContain('storageRoot=/tmp/storage')
  })
})

describe('naming the launch failure', () => {
  it('separates "the process died" from "the process was alive"', () => {
    expect(describeAppExit({ code: 1, signal: null })).toBe('exited (code=1, signal=null)')
    expect(describeAppExit({ code: null, signal: 'SIGKILL' })).toBe(
      'exited (code=null, signal=SIGKILL)'
    )
    expect(describeAppExit(undefined)).toBe('is still running')
  })

  it('points at the launch log and quotes its tail', () => {
    const message = launchFailureMessage({
      reason: 'the process exited before it produced a window',
      logPath: '/tmp/tr/app-process/002-x.log',
      exit: { code: 3, signal: null },
      tail: ['[main] boom', '[main] stack']
    })
    expect(message).toContain('never opened a window')
    expect(message).toContain('the process exited before it produced a window')
    expect(message).toContain('exited (code=3, signal=null)')
    expect(message).toContain('/tmp/tr/app-process/002-x.log')
    expect(message).toContain('[main] boom')
  })

  it('says so when that launch wrote nothing, instead of printing an empty section', () => {
    const message = launchFailureMessage({
      reason: 'Timeout 30000ms exceeded while waiting for event "window"',
      logPath: '/tmp/tr/app-process/001-y.log',
      exit: undefined,
      tail: []
    })
    expect(message).toContain('is still running')
    expect(message).toContain('wrote nothing')
    expect(message).not.toContain('last 0 lines')
  })
})

describe('raceWindowAgainstExit', () => {
  const never = new Promise<never>(() => undefined)

  it('returns the window when it arrives', async () => {
    const outcome = await raceWindowAgainstExit({
      firstWindow: async () => 'page',
      exited: never,
      logPath: '/tmp/x.log',
      readTail: async () => [],
      open: async (window) => window
    })
    expect(outcome).toEqual({ kind: 'window', window: 'page' })
  })

  it('returns the exit when the process dies first', async () => {
    const outcome = await raceWindowAgainstExit({
      firstWindow: () => never,
      exited: Promise.resolve({ code: 1, signal: null }),
      logPath: '/tmp/x.log',
      readTail: async () => [],
      open: async (window) => window
    })
    expect(outcome).toEqual({ kind: 'exited', exit: { code: 1, signal: null } })
  })
})

describe('openWindowOrNameFailure', () => {
  const never = new Promise<never>(() => undefined)

  it('opens the window through the caller', async () => {
    const open = vi.fn(async () => 'ready-page')
    await expect(
      openWindowOrNameFailure({
        firstWindow: async () => ({ id: 1 }),
        exited: never,
        logPath: '/tmp/x.log',
        readTail: async () => [],
        open
      })
    ).resolves.toBe('ready-page')
    expect(open).toHaveBeenCalledWith({ id: 1 })
  })

  it('fails at once when the process exited, instead of spending the window timeout', async () => {
    const started = Date.now()
    const readTail = vi.fn(async () => ['[main] cannot open database'])
    const error = await openWindowOrNameFailure({
      firstWindow: () => never,
      exited: Promise.resolve({ code: 1, signal: null }),
      logPath: '/tmp/tr/app-process/004-x.log',
      readTail,
      open: async (window) => window
    }).catch((thrown: unknown) => thrown as Error)

    expect(Date.now() - started).toBeLessThan(1000)
    expect(error.message).toContain('the process exited before it produced a window')
    expect(error.message).toContain('code=1')
    expect(error.message).toContain('/tmp/tr/app-process/004-x.log')
    expect(error.message).toContain('[main] cannot open database')
    expect(readTail).toHaveBeenCalledTimes(1)
  })

  it('keeps the timeout reason and still says the process was alive', async () => {
    const timeout = new Error('electronApplication.firstWindow: Timeout 30000ms exceeded')
    const error = await openWindowOrNameFailure({
      firstWindow: () => Promise.reject(timeout),
      exited: never,
      logPath: '/tmp/tr/app-process/005-y.log',
      readTail: async () => ['[main] still restoring'],
      open: async (window) => window
    }).catch((thrown: unknown) => thrown as Error)

    expect(error.message).toContain('firstWindow: Timeout 30000ms exceeded')
    expect(error.message).toContain('is still running')
    expect(error.message).toContain('[main] still restoring')
  })
})

describe('readTailLines', () => {
  const roots: string[] = []

  afterAll(async () => {
    await Promise.all(roots.map((root) => rm(root, { force: true, recursive: true })))
  })

  it('returns the last lines of a log and ignores the empty tail', async () => {
    const root = await mkdtemp(join(tmpdir(), 'app-process-log-'))
    roots.push(root)
    const path = join(root, 'launch.log')
    await writeFile(path, ['one', 'two', 'three', ''].join('\n'), 'utf8')

    await expect(readTailLines(path, 2)).resolves.toEqual(['two', 'three'])
  })

  it('reports a missing log as no lines rather than throwing', async () => {
    await expect(readTailLines('/nonexistent/app-process/000-x.log', 5)).resolves.toEqual([])
  })
})
