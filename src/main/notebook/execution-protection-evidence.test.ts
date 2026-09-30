import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  resolveExecutionProtection,
  type ExecutionSurface
} from '../../shared/execution-protection'
import type { NotebookRunRecord } from '../../shared/notebook'
import { NotebookRunRepository } from './repository'
import { NotebookRuntimeService } from './runtime-service'

let storageRoot: string | undefined

const createStorageRoot = async (): Promise<string> => {
  storageRoot = await mkdtemp(join(tmpdir(), 'purescience-protection-evidence-'))
  return storageRoot
}

afterEach(async () => {
  if (storageRoot) {
    await rm(storageRoot, { recursive: true, force: true })
    storageRoot = undefined
  }
})

const persistedRuns = async (root: string): Promise<NotebookRunRecord[]> => {
  const raw = await readFile(
    join(root, 'notebooks', 'default-project', 'session-1', 'run.json'),
    'utf8'
  )
  return (JSON.parse(raw) as { runs: NotebookRunRecord[] }).runs
}

describe('notebook run protection evidence', () => {
  it('stamps the protection level of each surface onto the run it produced', async () => {
    const root = await createStorageRoot()
    const asked: ExecutionSurface[] = []
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectName: 'default-project',
      repository: new NotebookRunRepository(root),
      platform: 'darwin',
      resolveExecutionProtection: async (surface) => {
        asked.push(surface)
        // A deliberately asymmetric level per surface: the assertion below is only meaningful if the
        // record carries the surface-specific answer rather than one shared snapshot.
        return resolveExecutionProtection({
          surface,
          platform: 'darwin',
          networkAllowlistEnabled: surface === 'notebook',
          osWriteGuardAvailable: true,
          capturedAt: 1_700_000_000_000
        })
      },
      executorFactory: () => ({
        execute: async (request) => ({
          status: 'completed',
          stdout: 'ok\n',
          stderr: '',
          traceback: '',
          cwdAfter: request.cwd,
          outputs: [{ type: 'stream', name: 'stdout', text: 'ok\n' }]
        }),
        shutdown: async () => ({ reaped: true })
      }),
      shellProcess: {
        execute: async () => ({ stdout: 'ok\n', stderr: '', exitCode: 0 })
      }
    })

    await service.execute({
      projectName: 'default-project',
      sessionId: 'session-1',
      workspaceCwd: root,
      code: 'print(1)'
    })
    await service.executeControl({ sessionId: 'session-1', workspaceCwd: root, code: 'return 1' })
    await service.executeShell({ sessionId: 'session-1', workspaceCwd: root, command: 'echo ok' })

    // The renderer-facing summary carries it too, so showing the level needs no extra IPC: the run
    // projection is a spread of the record.
    const summary = await service.execute({
      projectName: 'default-project',
      sessionId: 'session-1',
      workspaceCwd: root,
      code: 'print(2)'
    })
    expect(summary.executionProtection).toMatchObject({ surface: 'notebook', level: 'os-sandbox' })

    const runs = await persistedRuns(root)
    expect(runs).toHaveLength(4)
    expect(asked).toEqual(['notebook', 'shell', 'shell', 'notebook'])

    const byKind = new Map(runs.map((run) => [run.kernelKind, run]))
    expect(byKind.get('python')?.executionProtection).toMatchObject({
      surface: 'notebook',
      level: 'os-sandbox',
      platform: 'darwin',
      scope: { filesystem: 'runtime-write-protected', network: 'allowlist' },
      capturedAt: 1_700_000_000_000
    })
    // The control-plane repl kernel runs locally through the same wrapper as the terminal, so both
    // record the terminal surface — and the level gap is visible rather than smoothed over.
    expect(byKind.get('repl')?.executionProtection).toMatchObject({
      surface: 'shell',
      level: 'unprotected',
      unmet: [{ code: 'network-allowlist-disabled' }]
    })
    expect(byKind.get('bash')?.executionProtection).toMatchObject({
      surface: 'shell',
      level: 'unprotected'
    })
  })

  it('records a named unresolved gap instead of failing the run when the resolver throws', async () => {
    const root = await createStorageRoot()
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectName: 'default-project',
      repository: new NotebookRunRepository(root),
      platform: 'darwin',
      resolveExecutionProtection: async () => {
        throw new Error('settings unreadable')
      },
      executorFactory: () => ({
        execute: async (request) => ({
          status: 'completed',
          stdout: 'ok\n',
          stderr: '',
          traceback: '',
          cwdAfter: request.cwd,
          outputs: []
        }),
        shutdown: async () => ({ reaped: true })
      })
    })

    const summary = await service.execute({
      projectName: 'default-project',
      sessionId: 'session-1',
      workspaceCwd: root,
      code: 'print(1)'
    })

    // The execution the user asked for still happened...
    expect(summary.status).toBe('completed')
    // ...and the missing measurement is stated rather than implying a level was measured.
    const runs = await persistedRuns(root)
    expect(runs[0].executionProtection).toMatchObject({
      surface: 'notebook',
      level: 'unprotected',
      applied: [],
      unmet: [{ code: 'protection-unresolved', detail: 'settings unreadable' }]
    })
  })
})
