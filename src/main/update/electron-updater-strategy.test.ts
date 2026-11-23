import { EventEmitter } from 'node:events'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Logger } from '../logger'
import { ElectronUpdaterStrategy } from './electron-updater-strategy'
import {
  clearApplicationShutdownTrigger,
  currentApplicationShutdownTrigger
} from '../application-shutdown-trigger'

afterEach(() => clearApplicationShutdownTrigger())

// The default autoUpdater is never exercised here (every test injects a FakeUpdater); mock the module
// so importing the strategy doesn't pull a real Electron runtime into the test process. A stub
// CancellationToken stands in for the real class so the default token factory works in download().
vi.mock('electron-updater', () => ({
  autoUpdater: {},
  CancellationToken: class {
    cancelled = false
    cancel(): void {
      this.cancelled = true
    }
  }
}))

type FakeToken = { cancelled: boolean; cancel(): void }

// Faithful fake of electron-updater's autoUpdater. Critically, downloadUpdate models AppUpdater's real
// re-entrancy (out/AppUpdater.js): while a download is in progress it returns the SAME live
// downloadPromise and IGNORES the passed token; the promise is only cleared in a finally after the
// underlying download settles. This is what makes a naive "release the slot in cancel()" retry reuse
// the cancelled download instead of starting a fresh one.
class FakeUpdater extends EventEmitter {
  autoDownload = true
  autoInstallOnAppQuit = true
  // Only assigned by the tests that exercise the GitHub feed retry; electron-updater's real autoUpdater
  // always exposes it.
  setFeedURL?: (config: unknown) => void
  // The download body each call runs. Default: emit progress + downloaded and resolve. Tests override
  // it to hang, to inspect the token, or to count real starts.
  runDownload: (token?: FakeToken) => Promise<void> = async () => {
    this.emit('download-progress', {
      percent: 42,
      transferred: 4200,
      total: 10000,
      bytesPerSecond: 12345
    })
    this.emit('update-downloaded', { version: '0.3.0' })
  }
  private downloadPromise: Promise<void> | null = null
  checkForUpdates = vi.fn(async () => {
    this.emit('checking-for-update')
    this.emit('update-available', {
      version: '0.3.0',
      releaseNotes: 'notes',
      files: [{ url: 'https://cdn/PureScience-0.3.0.zip', size: 10000 }]
    })
  })
  downloadUpdate = vi.fn((token?: FakeToken): Promise<void> => {
    if (this.downloadPromise != null) return this.downloadPromise
    this.downloadPromise = this.runDownload(token).finally(() => {
      this.downloadPromise = null
    })
    return this.downloadPromise
  })
  quitAndInstall = vi.fn()
}

// Fake fetch returning a version.json manifest, so notes hydration never touches the network.
const manifestFetch = (manifest: object): typeof fetch =>
  vi.fn(async () => ({ ok: true, json: async () => manifest })) as unknown as typeof fetch

// Fake fetch that always fails, standing in for "no manifest reachable".
const offlineFetch = (): typeof fetch =>
  vi.fn(async () => {
    throw new Error('no network in test')
  }) as unknown as typeof fetch

const createLogSpy = (): Logger => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn()
})

const diagnosticRecords = (log: Logger): Record<string, unknown>[] =>
  (['debug', 'info', 'warn', 'error'] as const).flatMap((level) =>
    vi.mocked(log[level]).mock.calls.map(([, data]) => data as Record<string, unknown>)
  )

describe('ElectronUpdaterStrategy', () => {
  it('disables auto download/install on construction', () => {
    const updater = new FakeUpdater()
    new ElectronUpdaterStrategy({ updater, currentVersion: '0.2.0', broadcast: vi.fn() })
    expect(updater.autoDownload).toBe(false)
    expect(updater.autoInstallOnAppQuit).toBe(false)
  })

  it('maps check → available with restart applyKind', async () => {
    const broadcast = vi.fn()
    const updater = new FakeUpdater()
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      broadcast,
      fetchImpl: offlineFetch()
    })
    const status = await strategy.check()
    expect(status.state).toBe('available')
    expect(status.latest).toBe('0.3.0')
    expect(status.applyKind).toBe('restart')
    expect(broadcast).toHaveBeenCalledWith(
      'update:status',
      expect.objectContaining({ state: 'available' })
    )
  })

  it('records a completed in-place check without release notes or feed URLs', async () => {
    const updater = new FakeUpdater()
    const log = createLogSpy()
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      broadcast: vi.fn(),
      fetchImpl: offlineFetch(),
      manifestUrl: 'https://diagnostic-private.example/version.json?token=secret',
      log
    })

    await strategy.check()

    const records = diagnosticRecords(log)
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operation: 'update-check',
          outcome: 'completed',
          result: 'available'
        })
      ])
    )
    const serialized = JSON.stringify(records)
    expect(serialized).not.toContain('diagnostic-private')
    expect(serialized).not.toContain('notes')
  })

  it('maps download → progress then ready', async () => {
    const broadcast = vi.fn()
    const updater = new FakeUpdater()
    const log = createLogSpy()
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      broadcast,
      fetchImpl: offlineFetch(),
      log
    })
    await strategy.check()
    vi.mocked(log.info).mockClear()
    const status = await strategy.download()
    expect(broadcast).toHaveBeenCalledWith('update:progress', {
      phase: 'downloading',
      percent: 42,
      transferred: 4200,
      total: 10000,
      bytesPerSecond: 12345,
      attempt: 0
    })
    expect(status.state).toBe('ready')
    expect(diagnosticRecords(log)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operation: 'update-download',
          outcome: 'completed',
          result: 'ready'
        })
      ])
    )
  })

  it('records a failed in-place download without the provider error message', async () => {
    const updater = new FakeUpdater()
    updater.runDownload = async () => {
      throw new Error('private updater diagnostic detail')
    }
    const log = createLogSpy()
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      broadcast: vi.fn(),
      fetchImpl: offlineFetch(),
      log
    })
    await strategy.check()
    for (const level of ['debug', 'info', 'warn', 'error'] as const) {
      vi.mocked(log[level]).mockClear()
    }

    const status = await strategy.download()

    expect(status.error).toBe('private updater diagnostic detail')
    expect(status.errorReason).toBe('unknown')
    const records = diagnosticRecords(log)
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operation: 'update-download',
          outcome: 'failed',
          phase: 'transfer',
          errorCategory: 'error'
        })
      ])
    )
    expect(JSON.stringify(records)).not.toContain('private updater diagnostic detail')
  })

  it('stops a transfer that stops receiving bytes and names how far it got', async () => {
    vi.useFakeTimers()
    try {
      const updater = new FakeUpdater()
      let token: FakeToken | undefined
      let rejectDownload: ((error: Error) => void) | undefined
      // A transfer that reports one progress event and then goes silent — the shape the field log shows:
      // 2,283 s with no byte and no sentence about progress.
      updater.runDownload = async (given) => {
        token = given
        updater.emit('download-progress', {
          percent: 41,
          transferred: 122_000_000,
          total: 296_000_000,
          bytesPerSecond: 51_200
        })
        await new Promise<void>((_resolve, reject) => {
          rejectDownload = reject
        })
      }
      const log = createLogSpy()
      const strategy = new ElectronUpdaterStrategy({
        updater,
        currentVersion: '0.2.0',
        broadcast: vi.fn(),
        fetchImpl: offlineFetch(),
        log,
        downloadStallMs: 60_000,
        downloadAttempts: 1,
        createCancellationToken: () => {
          const created: FakeToken = {
            cancelled: false,
            cancel(): void {
              created.cancelled = true
              // electron-updater rejects the pending download when its token is cancelled.
              rejectDownload?.(new Error('cancelled by token'))
            }
          }
          token = created
          return created
        }
      })
      await strategy.check()
      for (const level of ['debug', 'info', 'warn', 'error'] as const) {
        vi.mocked(log[level]).mockClear()
      }

      const downloading = strategy.download()
      // Let download() reach the transfer and receive that first progress event.
      await vi.advanceTimersByTimeAsync(0)
      expect(token?.cancelled).toBe(false)

      await vi.advanceTimersByTimeAsync(60_000)
      const status = await downloading

      expect(status.state).toBe('error')
      expect(status.error).toContain('received no data for 60 s')
      expect(status.error).toContain('(41%)')
      expect(status.error).toContain('of 282.3 MB')
      expect(status.error).toContain('Nothing was installed')
      expect(token?.cancelled).toBe(true)
      const records = diagnosticRecords(log)
      expect(records).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            operation: 'update-download',
            outcome: 'failed',
            reason: 'stalled',
            stalledMs: 60_000,
            downloadedBytes: 122_000_000,
            totalBytes: 296_000_000,
            errorCategory: 'timeout'
          })
        ])
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a slow transfer alive: any new byte restarts the stall window', async () => {
    vi.useFakeTimers()
    try {
      const updater = new FakeUpdater()
      let token: FakeToken | undefined
      let release: (() => void) | undefined
      updater.runDownload = async (given) => {
        token = given
        updater.emit('download-progress', {
          percent: 10,
          transferred: 10_000,
          total: 100_000,
          bytesPerSecond: 1_000
        })
        await new Promise<void>((resolve) => (release = resolve))
      }
      const strategy = new ElectronUpdaterStrategy({
        updater,
        currentVersion: '0.2.0',
        broadcast: vi.fn(),
        fetchImpl: offlineFetch(),
        log: createLogSpy(),
        downloadStallMs: 60_000,
        downloadAttempts: 1
      })
      await strategy.check()

      const downloading = strategy.download()
      await vi.advanceTimersByTimeAsync(0)

      // 59 s of silence, then a byte: the window starts over instead of firing at the total elapsed 60 s.
      await vi.advanceTimersByTimeAsync(59_000)
      updater.emit('download-progress', {
        percent: 11,
        transferred: 11_000,
        total: 100_000,
        bytesPerSecond: 1_000
      })
      await vi.advanceTimersByTimeAsync(59_000)
      expect(token?.cancelled).toBe(false)
      expect(strategy.getStatus().state).toBe('downloading')

      // A full window of silence after that byte is a stall.
      await vi.advanceTimersByTimeAsync(1_000)
      expect(strategy.getStatus().state).toBe('error')
      release?.()
      await downloading
    } finally {
      vi.useRealTimers()
    }
  })

  // The attempt budget exists so a stalled transfer is restarted by the app instead of handed to the user
  // as an error they have to notice and act on.
  it('restarts a stalled transfer once instead of handing the stall to the user', async () => {
    vi.useFakeTimers()
    try {
      const updater = new FakeUpdater()
      const log = createLogSpy()
      const broadcast = vi.fn()
      let starts = 0
      let rejectCurrent: ((error: Error) => void) | undefined
      const tokens: FakeToken[] = []
      updater.runDownload = async () => {
        starts += 1
        updater.emit('download-progress', {
          percent: starts === 1 ? 41 : 3,
          transferred: starts === 1 ? 122_000_000 : 9_000_000,
          total: 296_000_000,
          bytesPerSecond: 51_200
        })
        if (starts === 1) {
          await new Promise<void>((_resolve, reject) => (rejectCurrent = reject))
          return
        }
        updater.emit('update-downloaded', { version: '0.3.0' })
      }
      const strategy = new ElectronUpdaterStrategy({
        updater,
        currentVersion: '0.2.0',
        broadcast,
        fetchImpl: offlineFetch(),
        log,
        downloadStallMs: 60_000,
        createCancellationToken: () => {
          const created: FakeToken = {
            cancelled: false,
            cancel(): void {
              created.cancelled = true
              rejectCurrent?.(new Error('cancelled by token'))
            }
          }
          tokens.push(created)
          return created
        }
      })
      await strategy.check()

      const downloading = strategy.download()
      await vi.advanceTimersByTimeAsync(0)
      expect(starts).toBe(1)

      await vi.advanceTimersByTimeAsync(60_000)
      const status = await downloading

      expect(starts).toBe(2)
      expect(tokens[0]?.cancelled).toBe(true)
      expect(status.state).toBe('ready')
      // The dialog is told the transfer starts over — not that it resumes, which the installer path does
      // and this one cannot (electron-updater deletes its temp file on failure).
      const progress = broadcast.mock.calls
        .filter(([channel]) => channel === 'update:progress')
        .map(([, payload]) => payload as Record<string, unknown>)
      expect(progress.find((entry) => entry.phase === 'restarting')).toMatchObject({
        phase: 'restarting',
        transferred: 0,
        attempt: 1
      })
      const records = diagnosticRecords(log)
      // The retry leaves its own record of what it abandoned — the next real-machine reading has to be
      // able to show that a stall happened and was restarted, not just that a download eventually worked.
      expect(records).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            attempt: 1,
            attempts: 2,
            stalledMs: 60_000,
            downloadedBytes: 122_000_000,
            totalBytes: 296_000_000
          })
        ])
      )
      // A stall that was recovered is not this download's outcome: no failed line was ever written.
      expect(records.some((record) => record.outcome === 'failed')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('gives up after the attempt budget and says how many attempts were spent', async () => {
    vi.useFakeTimers()
    try {
      const updater = new FakeUpdater()
      const log = createLogSpy()
      let starts = 0
      let rejectCurrent: ((error: Error) => void) | undefined
      updater.runDownload = async () => {
        starts += 1
        updater.emit('download-progress', {
          percent: 10,
          transferred: 10_000,
          total: 100_000,
          bytesPerSecond: 1_000
        })
        await new Promise<void>((_resolve, reject) => (rejectCurrent = reject))
      }
      const strategy = new ElectronUpdaterStrategy({
        updater,
        currentVersion: '0.2.0',
        broadcast: vi.fn(),
        fetchImpl: offlineFetch(),
        log,
        downloadStallMs: 60_000,
        createCancellationToken: () => {
          const created: FakeToken = {
            cancelled: false,
            cancel(): void {
              created.cancelled = true
              rejectCurrent?.(new Error('cancelled by token'))
            }
          }
          return created
        }
      })
      await strategy.check()
      const downloading = strategy.download()
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(60_000)
      await vi.advanceTimersByTimeAsync(60_000)
      const status = await downloading

      expect(starts).toBe(2)
      expect(status.state).toBe('error')
      expect(status.error).toContain('received no data for 60 s')
      const failed = diagnosticRecords(log).find((record) => record.outcome === 'failed')
      expect(failed).toMatchObject({ reason: 'stalled', attempts: 2, attemptsUsed: 2 })
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not restart a transfer whose failure a second attempt cannot fix', async () => {
    const updater = new FakeUpdater()
    const broadcast = vi.fn()
    updater.runDownload = async () => {
      updater.emit('download-progress', {
        percent: 8,
        transferred: 8_000,
        total: 100_000,
        bytesPerSecond: 500
      })
      // A byte-level failure: the retry would download the same broken file again.
      throw new Error('sha512 checksum mismatch, expected a different digest')
    }
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      broadcast,
      fetchImpl: offlineFetch(),
      log: createLogSpy(),
      downloadStallMs: 60_000
    })
    await strategy.check()
    const status = await strategy.download()

    expect(status.state).toBe('error')
    expect(status.error).toContain('sha512 checksum mismatch')
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1)
    const phases = broadcast.mock.calls
      .filter(([channel]) => channel === 'update:progress')
      .map(([, payload]) => (payload as { phase: string }).phase)
    expect(phases).not.toContain('restarting')
  })

  // Field reading that set this: one of three failed `update-download` operations in 2.32.0 was
  // `connection-reset` after 53 minutes — a live socket dying mid-stream, which a fresh connection can
  // survive. The stall watchdog cannot see it (the failure arrives as an error, not as silence).
  it('restarts a transfer whose connection was reset, and logs which class it restarted', async () => {
    const updater = new FakeUpdater()
    const log = createLogSpy()
    const broadcast = vi.fn()
    let starts = 0
    updater.runDownload = async () => {
      starts += 1
      updater.emit('download-progress', {
        percent: starts === 1 ? 60 : 5,
        transferred: starts === 1 ? 60_000 : 5_000,
        total: 100_000,
        bytesPerSecond: 2_000
      })
      if (starts === 1) throw new Error('net::ERR_CONNECTION_RESET')
      updater.emit('update-downloaded', { version: '0.3.0' })
    }
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      broadcast,
      fetchImpl: offlineFetch(),
      log,
      downloadStallMs: 60_000
    })
    await strategy.check()
    const status = await strategy.download()

    expect(starts).toBe(2)
    expect(status.state).toBe('ready')
    const progress = broadcast.mock.calls
      .filter(([channel]) => channel === 'update:progress')
      .map(([, payload]) => payload as Record<string, unknown>)
    // From zero, not "resuming": electron-updater deletes its temp file on any failure.
    expect(progress.find((entry) => entry.phase === 'restarting')).toMatchObject({
      phase: 'restarting',
      transferred: 0,
      attempt: 1
    })
    const records = diagnosticRecords(log)
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          attempt: 1,
          attempts: 2,
          errorCategory: 'connection-reset',
          downloadedBytes: 60_000,
          totalBytes: 100_000
        })
      ])
    )
    // A reset that was recovered is not this download's outcome.
    expect(records.some((record) => record.outcome === 'failed')).toBe(false)
  })

  it('spends the same attempt budget on a reset connection and names how many were used', async () => {
    const updater = new FakeUpdater()
    const log = createLogSpy()
    let starts = 0
    updater.runDownload = async () => {
      starts += 1
      updater.emit('download-progress', {
        percent: 10,
        transferred: 10_000,
        total: 100_000,
        bytesPerSecond: 1_000
      })
      throw new Error('net::ERR_CONNECTION_RESET')
    }
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      broadcast: vi.fn(),
      fetchImpl: offlineFetch(),
      log,
      downloadStallMs: 60_000
    })
    await strategy.check()
    const status = await strategy.download()

    expect(starts).toBe(2)
    expect(status.state).toBe('error')
    expect(status.error).toContain('ERR_CONNECTION_RESET')
    // The raw token stays in `error` (it is what a reader reports), and the reason is what the dialog
    // translates — both fields are asserted so neither half can be dropped silently.
    expect(status.errorReason).toBe('reset')
    const failed = diagnosticRecords(log).find((record) => record.outcome === 'failed')
    expect(failed).toMatchObject({
      errorCategory: 'connection-reset',
      attempts: 2,
      attemptsUsed: 2
    })
  })

  it('lets the user cancel the restarted attempt instead of finishing it for them', async () => {
    vi.useFakeTimers()
    try {
      const updater = new FakeUpdater()
      const broadcast = vi.fn()
      let starts = 0
      let rejectCurrent: ((error: Error) => void) | undefined
      const tokens: FakeToken[] = []
      updater.runDownload = async () => {
        starts += 1
        updater.emit('download-progress', {
          percent: 5,
          transferred: 5_000,
          total: 100_000,
          bytesPerSecond: 500
        })
        await new Promise<void>((_resolve, reject) => (rejectCurrent = reject))
      }
      const strategy = new ElectronUpdaterStrategy({
        updater,
        currentVersion: '0.2.0',
        broadcast,
        fetchImpl: offlineFetch(),
        log: createLogSpy(),
        downloadStallMs: 60_000,
        createCancellationToken: () => {
          const created: FakeToken = {
            cancelled: false,
            cancel(): void {
              created.cancelled = true
              rejectCurrent?.(new Error('cancelled by token'))
            }
          }
          tokens.push(created)
          return created
        }
      })
      await strategy.check()
      const downloading = strategy.download()
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(starts).toBe(2)

      const cancelled = await strategy.cancel()
      const final = await downloading

      expect(cancelled.state).toBe('available')
      expect(final.state).toBe('available')
      expect(final.error).toBeUndefined()
      expect(tokens[1]?.cancelled).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not report a user cancel as a transfer stall', async () => {
    vi.useFakeTimers()
    try {
      const updater = new FakeUpdater()
      const log = createLogSpy()
      let rejectDownload: ((error: Error) => void) | undefined
      const token: FakeToken = {
        cancelled: false,
        cancel(): void {
          token.cancelled = true
          rejectDownload?.(new Error('cancelled by token'))
        }
      }
      updater.runDownload = async () => {
        await new Promise<void>((_resolve, reject) => (rejectDownload = reject))
      }
      const strategy = new ElectronUpdaterStrategy({
        updater,
        currentVersion: '0.2.0',
        broadcast: vi.fn(),
        fetchImpl: offlineFetch(),
        log,
        downloadStallMs: 60_000,
        createCancellationToken: () => token
      })
      await strategy.check()
      for (const level of ['debug', 'info', 'warn', 'error'] as const) {
        vi.mocked(log[level]).mockClear()
      }

      const downloading = strategy.download()
      await vi.advanceTimersByTimeAsync(0)
      const cancelled = await strategy.cancel()
      expect(cancelled.state).toBe('available')
      const final = await downloading
      expect(final.state).toBe('available')
      expect(final.error).toBeUndefined()
      // The armed watchdog must be disarmed too: a cancel is not a stall, and a late firing would show an
      // error over a download the user already stopped.
      await vi.advanceTimersByTimeAsync(120_000)
      expect(strategy.getStatus().state).toBe('available')
      expect(JSON.stringify(diagnosticRecords(log))).not.toContain('"reason":"stalled"')
    } finally {
      vi.useRealTimers()
    }
  })

  it('carries how far the transfer got when it fails for another reason', async () => {
    const updater = new FakeUpdater()
    updater.runDownload = async () => {
      updater.emit('download-progress', {
        percent: 42,
        transferred: 4200,
        total: 10000,
        bytesPerSecond: 900
      })
      throw new Error('read ECONNRESET')
    }
    const log = createLogSpy()
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      broadcast: vi.fn(),
      fetchImpl: offlineFetch(),
      log
    })
    await strategy.check()
    for (const level of ['debug', 'info', 'warn', 'error'] as const) {
      vi.mocked(log[level]).mockClear()
    }

    const status = await strategy.download()

    expect(status.state).toBe('error')
    expect(status.error).toBe('read ECONNRESET (stopped at 4.1 KB of 9.8 KB)')
    expect(diagnosticRecords(log)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operation: 'update-download',
          outcome: 'failed',
          downloadedBytes: 4200,
          totalBytes: 10000
        })
      ])
    )
  })

  it('cancel aborts an in-flight download and resets the status to available', async () => {
    const updater = new FakeUpdater()
    let release: (() => void) | undefined
    let seenToken: FakeToken | undefined
    // Hang the download until released, then mimic electron-updater rejecting a cancelled download.
    updater.runDownload = async (token) => {
      seenToken = token
      await new Promise<void>((resolve) => (release = resolve))
      if (token?.cancelled) throw new Error('cancelled')
    }
    const log = createLogSpy()
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      broadcast: vi.fn(),
      fetchImpl: offlineFetch(),
      log
    })
    await strategy.check()
    for (const level of ['debug', 'info', 'warn', 'error'] as const) {
      vi.mocked(log[level]).mockClear()
    }

    const downloading = strategy.download()
    const cancelled = await strategy.cancel()
    expect(cancelled.state).toBe('available')
    expect(seenToken?.cancelled).toBe(true)

    // The rejected downloadUpdate must not clobber the reset status with an error.
    release?.()
    const final = await downloading
    expect(final.state).toBe('available')
    expect(final.error).toBeUndefined()
    expect(diagnosticRecords(log)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operation: 'update-download',
          outcome: 'cancelled',
          reason: 'user'
        })
      ])
    )
  })

  it('cancel is a no-op when nothing is downloading', async () => {
    const updater = new FakeUpdater()
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      broadcast: vi.fn(),
      fetchImpl: offlineFetch()
    })
    await strategy.check()
    const status = await strategy.cancel()
    expect(status.state).toBe('available')
  })

  it('ignores a second download() while one is already in flight', async () => {
    const updater = new FakeUpdater()
    let release: (() => void) | undefined
    let starts = 0
    updater.runDownload = async () => {
      starts += 1
      await new Promise<void>((resolve) => (release = resolve))
      updater.emit('update-downloaded', { version: '0.3.0' })
    }
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      broadcast: vi.fn(),
      fetchImpl: offlineFetch()
    })
    await strategy.check()

    const first = strategy.download()
    const second = strategy.download()
    expect(starts).toBe(1)

    release?.()
    await Promise.all([first, second])
    expect(starts).toBe(1)
    expect(strategy.getStatus().state).toBe('ready')
  })

  it('supports cancel followed by an immediate retry to completion', async () => {
    const updater = new FakeUpdater()
    let starts = 0
    let release: (() => void) | undefined
    // Models the real AppUpdater: the first (cancelled) download stays live until released; the retry
    // must NOT reuse it. Only a strategy that drains the old lifecycle before retrying lets the fake's
    // downloadPromise clear so downloadUpdate starts a genuine second download.
    updater.runDownload = async (token) => {
      starts += 1
      if (starts === 1) {
        await new Promise<void>((resolve) => (release = resolve))
        if (token?.cancelled) throw new Error('cancelled')
      } else {
        updater.emit('download-progress', { percent: 55, transferred: 5500, total: 10000 })
        updater.emit('update-downloaded', { version: '0.3.0' })
      }
    }
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      broadcast: vi.fn(),
      fetchImpl: offlineFetch()
    })
    await strategy.check()

    const first = strategy.download()
    const cancelled = await strategy.cancel()
    expect(cancelled.state).toBe('available')

    // Release the cancelled download so its live promise settles and clears, unblocking the retry's
    // drain. A real retry then starts a second, genuine download that completes.
    release?.()
    const retry = await strategy.download()
    expect(retry.state).toBe('ready')
    expect(starts).toBe(2)

    const firstFinal = await first
    expect(firstFinal.error).toBeUndefined()
  })

  it('reports up-to-date when no update is available', async () => {
    const updater = new FakeUpdater()
    updater.checkForUpdates = vi.fn(async () => {
      updater.emit('update-not-available', { version: '0.2.0' })
    })
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      broadcast: vi.fn()
    })
    const status = await strategy.check()
    expect(status.state).toBe('up-to-date')
  })

  it('surfaces errors as status error', async () => {
    const updater = new FakeUpdater()
    updater.checkForUpdates = vi.fn(async () => {
      updater.emit('error', new Error('raw provider diagnostic detail'))
    })
    const log = createLogSpy()
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      broadcast: vi.fn(),
      log
    })
    const status = await strategy.check()
    expect(status.state).toBe('error')
    expect(status.error).toBe('raw provider diagnostic detail')
    const records = diagnosticRecords(log)
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operation: 'update-check',
          outcome: 'failed',
          phase: 'query-provider',
          errorCategory: 'error'
        })
      ])
    )
    expect(JSON.stringify(records)).not.toContain('raw provider diagnostic detail')
  })

  it('apply installs silently and relaunches (quitAndInstall(true, true))', async () => {
    const updater = new FakeUpdater()
    const log = createLogSpy()
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      broadcast: vi.fn(),
      log
    })
    await strategy.apply()
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1)
    expect(updater.quitAndInstall).toHaveBeenCalledWith(true, true)
    expect(currentApplicationShutdownTrigger()).toBe('update')
    expect(diagnosticRecords(log)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operation: 'update-apply',
          outcome: 'completed',
          result: 'handoff-requested'
        })
      ])
    )
  })

  it('rolls back the update shutdown trigger when quitAndInstall throws', async () => {
    const updater = new FakeUpdater()
    updater.quitAndInstall.mockImplementation(() => {
      throw new Error('installer unavailable')
    })
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      broadcast: vi.fn()
    })

    const status = await strategy.apply()
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1)
    expect(updater.quitAndInstall).toHaveBeenCalledWith(true, true)
    expect(status.state).toBe('error')
    expect(currentApplicationShutdownTrigger()).toBe('quit')
  })

  it('apply runs the install gate before quitAndInstall when the teardown is clean', async () => {
    const updater = new FakeUpdater()
    const gate = vi.fn(async () => ({ completed: true, reaped: true }))
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      broadcast: vi.fn(),
      installGate: gate
    })

    await strategy.apply()

    expect(gate).toHaveBeenCalledTimes(1)
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1)
  })

  it('reports preparation immediately and ignores a repeat apply while teardown is pending', async () => {
    const updater = new FakeUpdater()
    const broadcast = vi.fn()
    let finishGate: (() => void) | undefined
    const gate = vi.fn(
      () =>
        new Promise<{ completed: true; reaped: true }>((resolve) => {
          finishGate = () => resolve({ completed: true, reaped: true })
        })
    )
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      broadcast,
      installGate: gate
    })

    const applying = strategy.apply()
    expect(strategy.getStatus().state).toBe('applying')
    expect(broadcast).toHaveBeenCalledWith(
      'update:status',
      expect.objectContaining({ state: 'applying' })
    )

    await strategy.apply()
    expect(gate).toHaveBeenCalledTimes(1)

    updater.emit('checking-for-update')
    await strategy.check()
    await strategy.download()
    expect(updater.checkForUpdates).not.toHaveBeenCalled()
    expect(updater.downloadUpdate).not.toHaveBeenCalled()
    expect(strategy.getStatus().state).toBe('applying')

    finishGate?.()
    await applying
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1)
  })

  it('apply refuses to install and names the cause when the teardown times out', async () => {
    const updater = new FakeUpdater()
    const gate = vi.fn(async () => ({
      completed: false,
      reaped: false,
      steps: { runtime: 'timeout' as const, notebook: 'completed' as const }
    }))
    const log = createLogSpy()
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      broadcast: vi.fn(),
      installGate: gate,
      log
    })

    const status = await strategy.apply()

    expect(updater.quitAndInstall).not.toHaveBeenCalled()
    expect(status.state).toBe('error')
    // The refusal is NAMED: which teardown, and that it ran out of budget (issue #17's U2 complaint
    // was a refusal the user could not act on).
    expect(status.error).toContain('did not stop in time')
    expect(status.error).toContain('agent runtime')
    expect(status.error).toContain('Please try again')
    expect(diagnosticRecords(log)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operation: 'update-apply',
          outcome: 'failed',
          phase: 'install-gate',
          reason: 'install-gate-timeout',
          gateCompleted: false,
          processTreesReaped: false,
          gateStepRuntime: 'timeout',
          gateStepNotebook: 'completed'
        })
      ])
    )
  })

  it('records a thrown install-gate failure without its error message', async () => {
    const updater = new FakeUpdater()
    const log = createLogSpy()
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      broadcast: vi.fn(),
      installGate: () => Promise.reject(new Error('private teardown diagnostic detail')),
      log
    })

    const status = await strategy.apply()

    expect(status.state).toBe('error')

    const records = diagnosticRecords(log)
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operation: 'update-apply',
          outcome: 'failed',
          phase: 'install-gate',
          errorCategory: 'error'
        })
      ])
    )
    expect(JSON.stringify(records)).not.toContain('private teardown diagnostic detail')
  })

  it('ignores stale updater errors during preparation', async () => {
    const updater = new FakeUpdater()
    let finishGate: (() => void) | undefined
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      broadcast: vi.fn(),
      installGate: () =>
        new Promise((resolve) => {
          finishGate = () => resolve({ completed: true, reaped: true })
        })
    })

    const applying = strategy.apply()
    updater.emit('error', new Error('stale download failure'))
    expect(strategy.getStatus().state).toBe('applying')
    finishGate?.()
    const status = await applying

    expect(status.state).toBe('applying')
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1)
  })

  it('restores an actionable error after the installer handoff starts', async () => {
    const updater = new FakeUpdater()
    const log = createLogSpy()
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      broadcast: vi.fn(),
      log
    })

    await strategy.apply()
    expect(currentApplicationShutdownTrigger()).toBe('update')
    updater.emit('error', new Error('installer failed'))

    expect(strategy.getStatus().state).toBe('error')
    expect(strategy.getStatus().error).toBe('installer failed')
    expect(currentApplicationShutdownTrigger()).toBe('quit')
    expect(diagnosticRecords(log)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operation: 'update-installer',
          outcome: 'failed',
          phase: 'handoff',
          errorCategory: 'error'
        })
      ])
    )
  })

  it('restores an actionable error when quitAndInstall throws', async () => {
    const updater = new FakeUpdater()
    updater.quitAndInstall.mockImplementationOnce(() => {
      throw new Error('installer launch failed')
    })
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      broadcast: vi.fn()
    })

    const status = await strategy.apply()

    expect(status.state).toBe('error')
    expect(status.error).toBe('installer launch failed')
  })

  it('restores an actionable error when the install gate throws', async () => {
    const updater = new FakeUpdater()
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      broadcast: vi.fn(),
      fetchImpl: offlineFetch(),
      installGate: vi.fn(async () => Promise.reject(new Error('teardown failed')))
    })
    await strategy.check()

    const status = await strategy.apply()

    expect(updater.quitAndInstall).not.toHaveBeenCalled()
    expect(status.state).toBe('error')
    expect(status.latest).toBe('0.3.0')
    expect(status.error).toContain('Please try again')
  })

  it('apply refuses to install and names the backend when the teardown completed but a tree was not cleanly reaped', async () => {
    const updater = new FakeUpdater()
    const gate = vi.fn(async () => ({
      completed: true,
      reaped: false,
      steps: { runtime: 'completed' as const, notebook: 'degraded' as const }
    }))
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      broadcast: vi.fn(),
      installGate: gate
    })

    const status = await strategy.apply()

    expect(updater.quitAndInstall).not.toHaveBeenCalled()
    expect(status.state).toBe('error')
    expect(status.error).toContain('notebook kernels')
    expect(status.error).toContain('Please try again')
  })

  it('refuses without inventing a backend name when the gate reports no step detail', async () => {
    const updater = new FakeUpdater()
    const gate = vi.fn(async () => ({ completed: false, reaped: false }))
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      broadcast: vi.fn(),
      installGate: gate
    })

    const status = await strategy.apply()

    expect(status.state).toBe('error')
    expect(status.error).toContain('did not stop in time')
    // Still named (the cause), just without a subsystem it cannot prove.
    expect(status.error).not.toContain('undefined')
    expect(status.error).not.toContain('()')
  })

  it('records the pending install before the handoff and keeps it when quitAndInstall succeeds', async () => {
    const updater = new FakeUpdater()
    const updateCache = {
      markInstallPending: vi.fn(async () => true),
      clearInstallPending: vi.fn(async () => {})
    }
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      broadcast: vi.fn(),
      updateCache
    })
    await strategy.check()
    await strategy.download()

    await strategy.apply()

    // The version the installer was asked to install — the next launch compares it with its own.
    expect(updateCache.markInstallPending).toHaveBeenCalledTimes(1)
    expect(updateCache.markInstallPending).toHaveBeenCalledWith('0.3.0')
    expect(updateCache.clearInstallPending).not.toHaveBeenCalled()
  })

  it('drops the pending-install claim when quitAndInstall throws', async () => {
    const updater = new FakeUpdater()
    updater.quitAndInstall.mockImplementationOnce(() => {
      throw new Error('installer launch failed')
    })
    const updateCache = {
      markInstallPending: vi.fn(async () => true),
      clearInstallPending: vi.fn(async () => {})
    }
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      broadcast: vi.fn(),
      updateCache
    })
    await strategy.check()

    const status = await strategy.apply()

    expect(status.state).toBe('error')
    // Nothing was handed over, so nothing is pending: the marker must not outlive the failed handoff.
    expect(updateCache.markInstallPending).toHaveBeenCalledTimes(1)
    expect(updateCache.clearInstallPending).toHaveBeenCalledTimes(1)
  })

  it('does not record a pending install when the gate refuses', async () => {
    const updater = new FakeUpdater()
    const updateCache = {
      markInstallPending: vi.fn(async () => true),
      clearInstallPending: vi.fn(async () => {})
    }
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      broadcast: vi.fn(),
      installGate: vi.fn(async () => ({ completed: true, reaped: false })),
      updateCache
    })
    await strategy.check()

    const status = await strategy.apply()

    expect(status.state).toBe('error')
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
    expect(updateCache.markInstallPending).not.toHaveBeenCalled()
  })

  it('hydrates notes from the CDN manifest when the version matches', async () => {
    const updater = new FakeUpdater()
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      broadcast: vi.fn(),
      fetchImpl: manifestFetch({ version: '0.3.0', downloads: {}, notes: '## Highlights\n- new' })
    })
    const status = await strategy.check()
    expect(status.notes).toBe('## Highlights\n- new')
  })

  it('keeps the GitHub-link fallback when the manifest version does not match', async () => {
    const updater = new FakeUpdater()
    // No releaseNotes in the feed, so without a matching manifest the notes stay empty.
    updater.checkForUpdates = vi.fn(async () => {
      updater.emit('update-available', { version: '0.3.0' })
    })
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      broadcast: vi.fn(),
      fetchImpl: manifestFetch({ version: '0.3.1', downloads: {}, notes: 'stale notes' })
    })
    const status = await strategy.check()
    expect(status.notes).toBe('')
  })

  it('keeps the fallback when the manifest fetch fails', async () => {
    const updater = new FakeUpdater()
    updater.checkForUpdates = vi.fn(async () => {
      updater.emit('update-available', { version: '0.3.0' })
    })
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      broadcast: vi.fn(),
      fetchImpl: offlineFetch()
    })
    const status = await strategy.check()
    expect(status.notes).toBe('')
  })

  it('extracts totalBytes from the updater feed artifact for the current platform', async () => {
    const updater = new FakeUpdater()
    updater.checkForUpdates = vi.fn(async () => {
      updater.emit('update-available', {
        version: '0.3.0',
        files: [
          { url: 'https://cdn/app-0.3.0-arm64.zip', size: 99000 },
          { url: 'https://cdn/app-0.3.0.dmg', size: 12000 }
        ]
      })
    })
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      platform: 'darwin',
      arch: 'arm64',
      broadcast: vi.fn(),
      fetchImpl: offlineFetch()
    })
    const status = await strategy.check()
    // darwin/arm64 → the arm64 ZIP (99000), not the DMG (12000).
    expect(status.totalBytes).toBe(99000)
  })

  it('matches the correct architecture in a multi-arch macOS feed', async () => {
    // Real latest-mac.yml carries both arm64 and x64 ZIPs; x64 must not pick arm64's size.
    const updater = new FakeUpdater()
    updater.checkForUpdates = vi.fn(async () => {
      updater.emit('update-available', {
        version: '0.3.0',
        files: [
          { url: 'https://cdn/app-0.3.0-arm64.zip', size: 95000 },
          { url: 'https://cdn/app-0.3.0-x64.zip', size: 105000 }
        ]
      })
    })
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      platform: 'darwin',
      arch: 'x64',
      isRosetta: () => false,
      broadcast: vi.fn(),
      fetchImpl: offlineFetch()
    })
    const status = await strategy.check()
    expect(status.totalBytes).toBe(105000)
  })

  it('omits totalBytes when multiple files match the platform and arch ambiguously', async () => {
    // If two files somehow match the same platform+arch+extension, don't guess.
    const updater = new FakeUpdater()
    updater.checkForUpdates = vi.fn(async () => {
      updater.emit('update-available', {
        version: '0.3.0',
        files: [
          { url: 'https://cdn/app-0.3.0-arm64.zip', size: 95000 },
          { url: 'https://cdn/app-0.3.0-arm64.zip', size: 105000 }
        ]
      })
    })
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      platform: 'darwin',
      arch: 'arm64',
      broadcast: vi.fn(),
      fetchImpl: offlineFetch()
    })
    const status = await strategy.check()
    expect(status.totalBytes).toBeUndefined()
  })

  it('resolves x64 under Rosetta to arm64 for artifact size selection', async () => {
    // An x64 app running under Rosetta 2 on Apple Silicon downloads the arm64 ZIP (electron-updater's
    // MacUpdater.filterFilesForArch does the same via sysctl.proc_translated). The pre-download size
    // must match the arm64 entry, not the x64 one.
    const updater = new FakeUpdater()
    updater.checkForUpdates = vi.fn(async () => {
      updater.emit('update-available', {
        version: '0.3.0',
        files: [
          { url: 'https://cdn/app-0.3.0-arm64.zip', size: 95000 },
          { url: 'https://cdn/app-0.3.0-x64.zip', size: 105000 }
        ]
      })
    })
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      platform: 'darwin',
      arch: 'x64',
      isRosetta: () => true,
      broadcast: vi.fn(),
      fetchImpl: offlineFetch()
    })
    const status = await strategy.check()
    // x64 + Rosetta → effective arm64 → picks 95000, not 105000.
    expect(status.totalBytes).toBe(95000)
  })

  it('keeps x64 arch when not under Rosetta', async () => {
    const updater = new FakeUpdater()
    updater.checkForUpdates = vi.fn(async () => {
      updater.emit('update-available', {
        version: '0.3.0',
        files: [
          { url: 'https://cdn/app-0.3.0-arm64.zip', size: 95000 },
          { url: 'https://cdn/app-0.3.0-x64.zip', size: 105000 }
        ]
      })
    })
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      platform: 'darwin',
      arch: 'x64',
      isRosetta: () => false,
      broadcast: vi.fn(),
      fetchImpl: offlineFetch()
    })
    const status = await strategy.check()
    // Native Intel x64 → picks 105000.
    expect(status.totalBytes).toBe(105000)
  })

  it('omits totalBytes when Rosetta status is uncertain and feed has both arches', async () => {
    // When the Rosetta probe returns undefined (e.g. sysctl failed), electron-updater might still
    // pick arm64. Don't guess — omit the size so the user sees no pre-download size label.
    const updater = new FakeUpdater()
    updater.checkForUpdates = vi.fn(async () => {
      updater.emit('update-available', {
        version: '0.3.0',
        files: [
          { url: 'https://cdn/app-0.3.0-arm64.zip', size: 95000 },
          { url: 'https://cdn/app-0.3.0-x64.zip', size: 105000 }
        ]
      })
    })
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      platform: 'darwin',
      arch: 'x64',
      isRosetta: () => undefined,
      broadcast: vi.fn(),
      fetchImpl: offlineFetch()
    })
    const status = await strategy.check()
    expect(status.totalBytes).toBeUndefined()
  })

  it('preserves check-time totalBytes when download-progress omits total', async () => {
    // Artifacts published with a size in the feed should keep that size even if a progress event
    // arrives without a total field.
    const updater = new FakeUpdater()
    updater.checkForUpdates = vi.fn(async () => {
      updater.emit('update-available', { version: '0.3.0', files: [{ size: 50000 }] })
    })
    updater.runDownload = async () => {
      // Progress event intentionally omits total — must not clobber the known 50000.
      updater.emit('download-progress', { percent: 10, transferred: 5000 })
      updater.emit('update-downloaded', { version: '0.3.0' })
    }
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      broadcast: vi.fn(),
      fetchImpl: offlineFetch()
    })
    await strategy.check()
    expect(strategy.getStatus().totalBytes).toBe(50000)

    const status = await strategy.download()
    expect(status.totalBytes).toBe(50000)
    expect(status.downloadedBytes).toBe(5000)
  })

  it('omits totalBytes when the updater feed has no artifact size', async () => {
    const updater = new FakeUpdater()
    updater.checkForUpdates = vi.fn(async () => {
      updater.emit('update-available', { version: '0.3.0' })
    })
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      broadcast: vi.fn(),
      fetchImpl: offlineFetch()
    })
    const status = await strategy.check()
    expect(status.totalBytes).toBeUndefined()
  })

  it('resets downloadedBytes to 0 when starting a new download', async () => {
    // A retry after cancel must not carry over the previous download's transferred bytes.
    const updater = new FakeUpdater()
    let starts = 0
    let release: (() => void) | undefined
    updater.runDownload = async (token) => {
      starts += 1
      if (starts === 1) {
        await new Promise<void>((resolve) => (release = resolve))
        if (token?.cancelled) throw new Error('cancelled')
      } else {
        updater.emit('download-progress', { percent: 55, transferred: 5500, total: 10000 })
        updater.emit('update-downloaded', { version: '0.3.0' })
      }
    }
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      broadcast: vi.fn(),
      fetchImpl: offlineFetch()
    })
    await strategy.check()

    const first = strategy.download()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(strategy.getStatus().downloadedBytes).toBe(0)

    await strategy.cancel()
    release?.()
    const retry = await strategy.download()
    expect(retry.state).toBe('ready')
    expect(starts).toBe(2)
    // The retry's progress event should report fresh transferred, not stale bytes.
    expect(retry.downloadedBytes).toBe(5500)
    await first
  })

  // The configured feed comes from app-update.yml and points at the CDN mirror, whose publish job is a
  // manual dispatch. An undeployed mirror must not cost the installed base its update prompt.
  it('retries the check on the GitHub feed when the configured feed cannot be reached', async () => {
    const updater = new FakeUpdater()
    const base = updater.checkForUpdates
    let switched = false
    updater.checkForUpdates = vi.fn(async () => {
      if (!switched) throw new Error('getaddrinfo ENOTFOUND statics.zerolink.com')
      await base()
    })
    const applyGithubFeed = vi.fn(() => {
      switched = true
    })
    const log = createLogSpy()
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      broadcast: vi.fn(),
      fetchImpl: offlineFetch(),
      applyGithubFeed,
      log
    })

    const status = await strategy.check()

    expect(applyGithubFeed).toHaveBeenCalledTimes(1)
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2)
    expect(status.state).toBe('available')
    expect(status.latest).toBe('0.3.0')
    expect(status.error).toBeUndefined()
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('retried on the GitHub feed'))
  })

  it('points the updater at the GitHub provider when it falls back', async () => {
    const updater = new FakeUpdater()
    const setFeedURL = vi.fn()
    updater.setFeedURL = setFeedURL
    const base = updater.checkForUpdates
    let switched = false
    updater.checkForUpdates = vi.fn(async () => {
      if (!switched) throw new Error('ENOTFOUND statics.zerolink.com')
      await base()
    })
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      broadcast: vi.fn(),
      fetchImpl: offlineFetch()
    })
    // The switch happens through the default seam; the fake starts failing until it is called.
    setFeedURL.mockImplementation(() => {
      switched = true
    })

    const status = await strategy.check()

    expect(setFeedURL).toHaveBeenCalledWith({
      provider: 'github',
      owner: 'naiyixi',
      repo: 'PureScience'
    })
    expect(status.state).toBe('available')
  })

  it('keeps the configured feed error when the GitHub retry fails too', async () => {
    const updater = new FakeUpdater()
    updater.checkForUpdates = vi.fn(async () => {
      throw new Error('getaddrinfo ENOTFOUND statics.zerolink.com')
    })
    const applyGithubFeed = vi.fn()
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      broadcast: vi.fn(),
      fetchImpl: offlineFetch(),
      applyGithubFeed
    })

    const status = await strategy.check()

    expect(applyGithubFeed).toHaveBeenCalledTimes(1)
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2)
    expect(status.state).toBe('error')
    // The first error names the feed this install is actually configured against.
    expect(status.error).toContain('statics.zerolink.com')
  })

  it('does not retry on GitHub when the app has no update feed at all (dev build)', async () => {
    const updater = new FakeUpdater()
    updater.checkForUpdates = vi.fn(async () => {
      throw new Error(
        'Skip checkForUpdates because application is not packed and dev update config is not forced'
      )
    })
    const applyGithubFeed = vi.fn()
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      broadcast: vi.fn(),
      fetchImpl: offlineFetch(),
      applyGithubFeed
    })

    const status = await strategy.check()

    // A build-configuration state, not an unreachable feed: retrying would spend a round-trip that
    // cannot help and would replace an accurate error with a confusing one.
    expect(applyGithubFeed).not.toHaveBeenCalled()
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1)
    expect(status.state).toBe('error')
    expect(status.error).toContain('not packed')
  })

  // Measured on a macOS runner: the app's own startup check reached phase `query-provider` and had still
  // not answered two minutes later, so the window said "checking" forever and nothing could say why.
  // electron-updater has no timeout of its own, so a budget here is the difference between "still checking"
  // and "the feed did not answer in 20 s".
  it('reports a named failure instead of staying in checking when the provider never answers', async () => {
    const updater = new FakeUpdater()
    updater.checkForUpdates = vi.fn(() => new Promise<never>(() => undefined))
    const strategy = new ElectronUpdaterStrategy({ updater, broadcast: vi.fn(), checkBudgetMs: 20 })

    const status = await strategy.check()

    expect(status.state).toBe('error')
    expect(status.error).toContain('did not answer within 20 ms')
    // The dialog has a sentence per reason; a budget that ran out is the timeout one, so the reader never
    // sees the internal "did not answer within 20 ms" budget figure as the whole message.
    expect(status.errorReason).toBe('timeout')
    // No GitHub retry: a request that never settles would only spend a second budget on the same silence.
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1)
  })

  it('does not cut off a provider that answers inside its budget', async () => {
    const updater = new FakeUpdater()
    updater.checkForUpdates = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30))
      updater.emit('update-available', { version: '2.33.1', files: [] })
    })
    const strategy = new ElectronUpdaterStrategy({ updater, broadcast: vi.fn(), checkBudgetMs: 5_000 })

    const status = await strategy.check()

    expect(status.state).toBe('available')
    expect(status.latest).toBe('2.33.1')
  })
})
