import { EventEmitter } from 'node:events'
import { createServer, type Server } from 'node:http'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import type { Logger } from '../logger'
import { ElectronUpdaterStrategy, type MinimalCancellationToken } from './electron-updater-strategy'

// The unit suite proves the watchdog against a fake emitter; this one proves it against a real TCP
// stream that really stops sending, with real timers. It is the closest reading available without a
// packaged build: electron-updater owns the HTTP transfer, and the only way to make it stall on demand
// is to hand it a server that sends part of a body and then goes quiet.
vi.mock('electron-updater', () => ({
  autoUpdater: {},
  CancellationToken: class {
    cancelled = false
    cancel(): void {
      this.cancelled = true
    }
  }
}))

const ARTIFACT_BYTES = 5 * 1024 * 1024
const SENT_BEFORE_STALL = 1024 * 1024
const STALL_BUDGET_MS = 2_000

let server: Server
let port = 0

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/feed/latest.yml') {
      res.writeHead(200, { 'content-type': 'text/yaml' })
      res.end('version: 0.3.0\n')
      return
    }
    // 1 MB of a 5 MB body, then silence: never end(), never write again.
    res.writeHead(200, {
      'content-length': String(ARTIFACT_BYTES),
      'content-type': 'application/octet-stream'
    })
    res.write(Buffer.alloc(SENT_BEFORE_STALL, 7))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  port = typeof address === 'object' && address ? address.port : 0
})

afterAll(async () => {
  server.closeAllConnections?.()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

// Drives the real strategy from a real fetch: bytes actually read off the socket become the progress
// events electron-updater would emit.
class SocketUpdater extends EventEmitter {
  autoDownload = true
  autoInstallOnAppQuit = true
  controller?: AbortController
  checkForUpdates = vi.fn(async () => {
    this.emit('update-available', {
      version: '0.3.0',
      releaseNotes: '',
      files: [{ url: `http://127.0.0.1:${port}/app.zip`, size: ARTIFACT_BYTES }]
    })
  })
  downloadUpdate = async (token?: MinimalCancellationToken): Promise<void> => {
    const controller = new AbortController()
    this.controller = controller
    const originalCancel = token?.cancel.bind(token)
    if (token) {
      token.cancel = (): void => {
        originalCancel?.()
        controller.abort()
      }
    }
    const response = await fetch(`http://127.0.0.1:${port}/app.zip`, { signal: controller.signal })
    const body = response.body
    if (!body) throw new Error('no body')
    const reader = body.getReader()
    let transferred = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      transferred += value.byteLength
      this.emit('download-progress', {
        percent: (transferred / ARTIFACT_BYTES) * 100,
        transferred,
        total: ARTIFACT_BYTES,
        bytesPerSecond: 1024
      })
    }
  }
  quitAndInstall = vi.fn()
}

const quietLog = (): Logger => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })

describe('ElectronUpdaterStrategy over a real stalled socket', () => {
  it('names the stall from bytes that really arrived, then aborts the socket', async () => {
    const updater = new SocketUpdater()
    const log = quietLog()
    const strategy = new ElectronUpdaterStrategy({
      updater: updater as never,
      currentVersion: '0.2.0',
      broadcast: vi.fn(),
      fetchImpl: (async () => {
        throw new Error('offline')
      }) as unknown as typeof fetch,
      log,
      downloadStallMs: STALL_BUDGET_MS
    })

    await strategy.check()
    const started = Date.now()
    const status = await strategy.download()
    const elapsed = Date.now() - started

    const records = (['debug', 'info', 'warn', 'error'] as const).flatMap((level) =>
      vi.mocked(log[level]).mock.calls.map(([, data]) => data as Record<string, unknown>)
    )
    const failed = records.find((record) => record && record.outcome === 'failed')

    expect(status.state).toBe('error')
    expect(status.error).toContain(`received no data for ${STALL_BUDGET_MS / 1000} s`)
    expect(status.error).toContain('of 5.0 MB')
    expect(status.error).toContain('Nothing was installed')
    expect(failed?.reason).toBe('stalled')
    expect(failed?.errorCategory).toBe('timeout')
    expect(Number(failed?.downloadedBytes)).toBe(SENT_BEFORE_STALL)
    // A real timer was actually waited out (not fired early by the fake clock of the unit suite).
    expect(elapsed).toBeGreaterThanOrEqual(STALL_BUDGET_MS - 100)
    expect(updater.controller?.signal.aborted).toBe(true)
  }, 20_000)
})
