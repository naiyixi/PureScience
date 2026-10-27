import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { NotebookRunRepository } from './repository'
import { NotebookRuntimeService } from './runtime-service'
import { sharedLoopHeldWindows } from '../diagnostics/loop-held-windows'

// A `notebook:state` read is slow for exactly two different reasons — a large run.json we parse
// ourselves, or a main thread that was not running our code — and the field totals on this machine
// (n=116, p50 1,168 ms, p95 21,560 ms) cannot tell them apart. The slow line therefore has to name the
// phases, and these tests pin that it does, that it stays silent when the read is cheap, and that a
// broken logger can never fail the answer it is describing.

let storageRoot: string | undefined

const createStorageRoot = async (): Promise<string> => {
  storageRoot = await mkdtemp(join(tmpdir(), 'purescience-notebook-state-attribution-'))
  return storageRoot
}

afterEach(async () => {
  if (storageRoot) {
    await rm(storageRoot, { recursive: true, force: true })
    storageRoot = undefined
  }
})

// Delays only the durable read, which is the phase the line has to attribute.
class DelayedReadRepository extends NotebookRunRepository {
  constructor(
    root: string,
    private readonly delayMs: number
  ) {
    super(root)
  }

  override async loadOrCreate(
    request: Parameters<NotebookRunRepository['loadOrCreate']>[0]
  ): ReturnType<NotebookRunRepository['loadOrCreate']> {
    await new Promise((resolve) => setTimeout(resolve, this.delayMs))
    return super.loadOrCreate(request)
  }
}

const makeService = (
  root: string,
  options: {
    repository?: NotebookRunRepository
    logger?: { warn: (message: string, data?: unknown) => void }
  } = {}
): NotebookRuntimeService =>
  new NotebookRuntimeService({
    configRoot: root,
    dataRoot: root,
    projectName: 'default-project',
    repository: options.repository ?? new NotebookRunRepository(root),
    ...(options.logger
      ? { logger: { info: vi.fn(), warn: options.logger.warn, error: vi.fn() } }
      : {}),
    executorFactory: () => ({
      execute: async () => ({
        status: 'completed' as const,
        stdout: '',
        stderr: '',
        traceback: '',
        cwdAfter: '/workspace',
        outputs: []
      }),
      shutdown: async () => ({ reaped: true })
    })
  })

describe('notebook:state slow-read attribution', () => {
  it('names ensure, load and projection when the read crosses the threshold', async () => {
    const root = await createStorageRoot()
    const warn = vi.fn()
    const service = makeService(root, {
      repository: new DelayedReadRepository(root, 260),
      logger: { warn }
    })

    const state = await service.state({ sessionId: 'session-1', workspaceCwd: '/workspace' })

    expect(warn).toHaveBeenCalledTimes(1)
    const [message, data] = warn.mock.calls[0] as [
      string,
      Record<string, number | string | boolean>
    ]
    expect(message).toBe('notebook state read was slow')
    expect(data).toMatchObject({ sessionId: 'session-1', cold: true, runs: state.runs.length })
    // The delayed phase is the durable read, and the numbers have to say so rather than just adding up.
    expect(data.loadMs as number).toBeGreaterThanOrEqual(250)
    expect(data.totalMs as number).toBeGreaterThanOrEqual(data.loadMs as number)
    expect(data.projectMs as number).toBeGreaterThanOrEqual(0)
    expect(data.ensureMs as number).toBeGreaterThanOrEqual(0)
    // The line carries a count, never a run: no code, no output, no session document content.
    expect(JSON.stringify(data)).not.toContain('stdout')
    // The attribution fields are on this line too. The verdict is whatever the machine did, so only the key
    // set and the vocabulary are pinned here — the two verdicts themselves are pinned in coordinator.test.ts.
    expect(Object.keys(data)).toEqual(expect.arrayContaining(['cpuMs', 'cpuShare', 'attribution']))
    expect(['cpu-bound-in-process', 'no-cpu-in-process', 'inconclusive']).toContain(
      data.attribution
    )
  })

  it('reports a warm read as not cold and stays silent below the threshold', async () => {
    const root = await createStorageRoot()
    const warn = vi.fn()
    const service = makeService(root, {
      repository: new DelayedReadRepository(root, 260),
      logger: { warn }
    })

    await service.state({ sessionId: 'session-1', workspaceCwd: '/workspace' })
    await service.state({ sessionId: 'session-1', workspaceCwd: '/workspace' })

    const second = warn.mock.calls[1] as [string, Record<string, number | string | boolean>]
    expect(second[1].cold).toBe(false)

    const quietService = makeService(root, { logger: { warn } })
    warn.mockClear()
    await quietService.state({ sessionId: 'session-2', workspaceCwd: '/workspace' })
    expect(warn).not.toHaveBeenCalled()
  })

  it('returns the answer even when the logger throws', async () => {
    const root = await createStorageRoot()
    const service = makeService(root, {
      repository: new DelayedReadRepository(root, 260),
      logger: {
        warn: () => {
          throw new Error('log sink is gone')
        }
      }
    })

    const state = await service.state({ sessionId: 'session-1', workspaceCwd: '/workspace' })

    expect(state.sessionId).toBe('session-1')
    expect(state.runJsonPath).toContain('run.json')
  })

  // The phase split answers "which part of the read was it"; the held split answers "was the loop running
  // while it accrued". A suspended process reads as a slow parse on `loadMs` alone. The window is written on
  // the loop's own clock (what the stall watchdog records) and covers the whole measurement, so every
  // measured millisecond has to be reported as held — deleting the spread at this call site leaves `heldMs`
  // absent entirely, which is how "nobody measured" and "the loop was free" differ.
  it('carries the held split, so a read that looked slow reads that way for a reason', async () => {
    const root = await createStorageRoot()
    const heldStart = performance.now() - 5_000
    sharedLoopHeldWindows.record(heldStart, heldStart + 65_000)
    const warn = vi.fn()
    const service = makeService(root, {
      repository: new DelayedReadRepository(root, 260),
      logger: { warn }
    })

    await service.state({ sessionId: 'session-1', workspaceCwd: '/workspace' })

    const [, data] = warn.mock.calls[0] as [string, Record<string, number | string | boolean>]
    expect(data.heldMs).toBe(data.totalMs)
    expect(data.ownMs).toBe(0)
  })
})
