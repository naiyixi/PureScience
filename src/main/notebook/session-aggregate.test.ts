import { describe, expect, it, vi } from 'vitest'

import type { NotebookCell } from '../../shared/notebook'

import { NotebookSessionAggregate } from './session-aggregate'

describe('NotebookSessionAggregate', () => {
  it('serializes execution for one process while allowing another process to run', async () => {
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const started: string[] = []
    const session = new NotebookSessionAggregate({
      sessionId: 'session-1',
      projectName: 'default-project',
      cwd: '/workspace/data',
      notebookSessionRoot: '/workspace',
      dataRoot: '/workspace/data',
      runtimeRoot: '/runtime',
      runJsonPath: '/workspace/run.json',
      executionCount: 0,
      executorGeneration: Symbol('executor-1'),
      executor: {
        execute: async () => ({
          status: 'completed',
          stdout: '',
          stderr: '',
          traceback: '',
          cwdAfter: '/workspace/data',
          outputs: []
        }),
        shutdown: async () => ({ reaped: true })
      }
    })

    const first = session.enqueueExecution('python:default-python', async () => {
      started.push('first')
      await firstGate
      return 'first-result'
    })
    const second = session.enqueueExecution('python:default-python', async () => {
      started.push('second')
      return 'second-result'
    })
    const other = session.enqueueExecution('r:default-r', async () => {
      started.push('other')
      return 'other-result'
    })

    await expect(other).resolves.toBe('other-result')
    expect(started).toEqual(['first', 'other'])

    releaseFirst()
    await expect(Promise.all([first, second])).resolves.toEqual(['first-result', 'second-result'])
    expect(started).toEqual(['first', 'other', 'second'])
  })

  it('returns snapshots that cannot mutate owned cell or kernel state', () => {
    const session = new NotebookSessionAggregate({
      sessionId: 'session-1',
      projectName: 'default-project',
      cwd: '/workspace/data',
      notebookSessionRoot: '/workspace',
      dataRoot: '/workspace/data',
      runtimeRoot: '/runtime',
      runJsonPath: '/workspace/run.json',
      executionCount: 0,
      executorGeneration: Symbol('executor-1'),
      executor: {
        execute: async () => ({
          status: 'completed',
          stdout: '',
          stderr: '',
          traceback: '',
          cwdAfter: '/workspace/data',
          outputs: []
        }),
        shutdown: async () => ({ reaped: true })
      }
    })
    session.beginCellWrite({
      cellId: 'cell-1',
      language: 'python',
      writeId: 'write-1',
      source: 'agent',
      startedAt: 1
    })
    session.appendCellCode('cell-1', 'write-1', 'original')
    session.finishCellWrite('cell-1', 'write-1')
    session.setKernelStatus('python:default-python', 'idle')

    const snapshot = session.snapshot()
    ;(snapshot.cells as NotebookCell[])[0].code = 'mutated'
    ;(snapshot.kernelStatuses as Array<[string, (typeof snapshot.kernelStatuses)[number][1]]>).push(
      ['r:default-r', 'running']
    )

    expect(session.snapshot()).toMatchObject({
      cells: [{ id: 'cell-1', code: 'original', status: 'idle' }],
      kernelStatuses: [['python:default-python', 'idle']]
    })
  })

  it('refuses the in-flight run immediately, then tears the executor down after the lifecycle queue', async () => {
    const order: string[] = []
    const shutdownOptions: Array<{ interruptionReason?: 'app-terminated' } | undefined> = []
    const refuseOptions: Array<{ interruptionReason?: 'app-terminated' } | undefined> = []
    let releaseCallback!: () => void
    const callbackGate = new Promise<void>((resolve) => {
      releaseCallback = resolve
    })
    const generation = Symbol('executor-1')
    const session = new NotebookSessionAggregate({
      sessionId: 'session-1',
      projectName: 'default-project',
      cwd: '/workspace/data',
      notebookSessionRoot: '/workspace',
      dataRoot: '/workspace/data',
      runtimeRoot: '/runtime',
      runJsonPath: '/workspace/run.json',
      executionCount: 1,
      executorGeneration: generation,
      executor: {
        execute: async () => ({
          status: 'running',
          stdout: '',
          stderr: '',
          traceback: '',
          cwdAfter: '/workspace/data',
          outputs: []
        }),
        refuseInflightRuns: (options) => {
          order.push('refuse')
          refuseOptions.push(options)
        },
        shutdown: async (options) => {
          order.push('shutdown')
          shutdownOptions.push(options)
          return { reaped: true }
        }
      }
    })

    // A queued executor-lifecycle callback (a kernel-status write) that is still outstanding. The refusal must
    // not wait for it — that is what a quit with no budget left never survived — while the teardown must.
    const callback = session.runExecutorLifecycleCallback(generation, async () => {
      order.push('callback')
      await callbackGate
      return 'persisted'
    })
    await vi.waitFor(() => expect(order).toContain('callback'))

    const teardown = session.shutdownExecutor().then((result) => {
      order.push('teardown')
      return result
    })

    // Dispatched synchronously with the teardown call, and it names why: 'app-terminated' is what turns the
    // refused run into the domain's interrupted record instead of a failure.
    expect(order).toEqual(['callback', 'refuse'])
    expect(refuseOptions).toEqual([{ interruptionReason: 'app-terminated' }])
    // ...and the process-tree teardown has NOT started yet: a queued persistence write is never cut off.
    expect(shutdownOptions).toEqual([])

    releaseCallback()
    await expect(callback).resolves.toBe('persisted')
    await expect(teardown).resolves.toEqual({ reaped: true })
    expect(order).toEqual(['callback', 'refuse', 'shutdown', 'teardown'])
    expect(shutdownOptions).toEqual([{ interruptionReason: 'app-terminated' }])
  })
})
