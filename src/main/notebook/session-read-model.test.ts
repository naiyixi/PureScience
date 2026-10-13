import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { NotebookRunRecord } from '../../shared/notebook'
import { NotebookRunRepository, getNotebookRunJsonPath, getRuntimeRoot } from './repository'
import { NotebookSessionReadModel, type NotebookSessionReadSource } from './session-read-model'
import type { NotebookSessionSnapshot } from './session-aggregate'

let root: string | undefined

const createRoot = async (): Promise<string> => {
  root = await mkdtemp(join(tmpdir(), 'notebook-read-model-'))
  return root
}

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true })
  root = undefined
})

const makeSession = (
  storageRoot: string,
  snapshotOverrides: Partial<NotebookSessionSnapshot> = {},
  withRuntimeBinding = false
): NotebookSessionReadSource => {
  const sessionId = 'session-1'
  const projectName = 'default-project'
  const notebookSessionRoot = join(storageRoot, 'notebooks', projectName, sessionId)
  const snapshot: NotebookSessionSnapshot = {
    id: `notebook-session-${sessionId}`,
    sessionId,
    projectName,
    cwd: join(storageRoot, 'workspace'),
    notebookSessionRoot,
    dataRoot: join(notebookSessionRoot, 'data'),
    runtimeRoot: getRuntimeRoot(storageRoot),
    runJsonPath: join(notebookSessionRoot, 'run.json'),
    cells: [],
    executionCount: 0,
    kernelStatuses: [],
    ...snapshotOverrides
  }
  return {
    id: snapshot.id,
    sessionId,
    projectName,
    cwd: snapshot.cwd,
    notebookSessionRoot,
    dataRoot: snapshot.dataRoot,
    runtimeRoot: snapshot.runtimeRoot,
    runJsonPath: snapshot.runJsonPath,
    snapshot: () => snapshot,
    kernelStatusEntries: () => snapshot.kernelStatuses.map((entry) => [...entry]),
    runtimeBindingEntries: () =>
      withRuntimeBinding
        ? [
            [
              'python',
              {
                runtimeId: 'managed-python',
                language: 'python',
                label: 'Python 3.13',
                source: 'managed',
                provenance: 'app-managed',
                interpreterPath: join(getRuntimeRoot(storageRoot), 'python'),
                status: 'active'
              }
            ]
          ]
        : []
  }
}

const makeReadModel = (
  storageRoot: string,
  session: NotebookSessionReadSource | undefined,
  repository = new NotebookRunRepository(storageRoot)
): NotebookSessionReadModel<NotebookSessionReadSource> =>
  new NotebookSessionReadModel({
    storageRoot,
    defaultProjectName: 'default-project',
    repository,
    findSession: vi.fn(() => session),
    runtimeBindings: () => ({
      python: {
        runtimeId: 'managed-python',
        language: 'python',
        label: 'Python 3.13',
        source: 'managed',
        provenance: 'app-managed',
        interpreterPath: join(getRuntimeRoot(storageRoot), 'python'),
        status: 'active'
      }
    }),
    isRestartRecommended: (processKey) => processKey === 'r:analysis'
  })

describe('NotebookSessionReadModel', () => {
  it('returns only actionable live handoff data and never consults durable storage', async () => {
    const storageRoot = await createRoot()
    const repository = new NotebookRunRepository(storageRoot)
    const findExisting = vi.spyOn(repository, 'findExisting')
    const empty = makeSession(storageRoot)

    expect(
      makeReadModel(storageRoot, undefined, repository).peekHandoffContext('missing')
    ).toBeUndefined()
    expect(
      makeReadModel(storageRoot, empty, repository).peekHandoffContext('session-1')
    ).toBeUndefined()

    const active = makeSession(
      storageRoot,
      {
        executionCount: 8,
        activeRunId: 'run-8',
        cells: [
          { id: 'cell-8', language: 'r', code: '1 + 1', status: 'running', latestRunId: 'run-8' }
        ],
        kernelStatuses: [
          ['python:default-python', 'terminated'],
          ['r:analysis', 'running']
        ]
      },
      true
    )
    expect(makeReadModel(storageRoot, active, repository).peekHandoffContext('session-1')).toEqual({
      activeRunId: 'run-8',
      executionCount: 8,
      cells: [{ id: 'cell-8', language: 'r', status: 'running', latestRunId: 'run-8' }],
      kernels: [{ kind: 'r', status: 'running' }],
      runtimes: [{ language: 'python', label: 'Python 3.13', status: 'active' }]
    })
    expect(findExisting).not.toHaveBeenCalled()
  })

  it('combines the live aggregate with durable history and preserves environment projection', async () => {
    const storageRoot = await createRoot()
    const repository = new NotebookRunRepository(storageRoot)
    const session = makeSession(storageRoot, {
      cells: [{ id: 'cell-1', language: 'python', code: '1', status: 'completed' }],
      kernelStatuses: [
        ['repl', 'idle'],
        ['r:analysis', 'running']
      ]
    })
    await repository.loadOrCreate({
      projectName: session.projectName,
      sessionId: session.sessionId,
      workspaceCwd: session.cwd,
      pythonPath: join(getRuntimeRoot(storageRoot), 'python')
    })

    const state = await makeReadModel(storageRoot, session, repository).state(session)

    expect(state).toMatchObject({
      id: session.id,
      sessionId: session.sessionId,
      pythonPath: join(getRuntimeRoot(storageRoot), 'python'),
      cells: [{ id: 'cell-1', status: 'completed' }],
      runs: [],
      recentRuns: [],
      environments: [
        { processKey: 'repl', kind: 'repl', status: 'idle' },
        {
          processKey: 'r:analysis',
          kind: 'r',
          environment: 'analysis',
          status: 'running',
          restartRecommended: true
        }
      ],
      runtimeBindings: { python: { runtimeId: 'managed-python' } }
    })
  })

  it('prefers a live reference and otherwise falls back to normalized durable roots', async () => {
    const storageRoot = await createRoot()
    const repository = new NotebookRunRepository(storageRoot)
    const session = makeSession(storageRoot, { cwd: String.raw`C:\Users\analyst\workspace` })
    const liveModel = makeReadModel(storageRoot, session, repository)

    await expect(
      liveModel.getSessionReference({
        sessionId: session.sessionId,
        workspaceCwd: join(storageRoot, 'ignored')
      })
    ).resolves.toEqual(liveModel.toSessionReference(session))
    expect(liveModel.toSessionReference(session).workspaceCwd).toBe(
      String.raw`C:\Users\analyst\workspace`
    )

    const persistedWorkspace = join(storageRoot, 'persisted-workspace')
    await repository.loadOrCreate({
      projectName: session.projectName,
      sessionId: session.sessionId,
      workspaceCwd: persistedWorkspace
    })
    const durableModel = makeReadModel(storageRoot, undefined, repository)
    await expect(
      durableModel.getSessionReference({
        sessionId: session.sessionId,
        workspaceCwd: join(storageRoot, 'ignored')
      })
    ).resolves.toEqual({
      sessionId: session.sessionId,
      projectName: session.projectName,
      workspaceCwd: persistedWorkspace,
      notebookSessionRoot: session.notebookSessionRoot,
      dataRoot: session.dataRoot,
      runtimeRoot: session.runtimeRoot,
      runJsonPath: getNotebookRunJsonPath(storageRoot, session.projectName, session.sessionId)
    })
    await expect(
      durableModel.getSessionReference({
        sessionId: 'missing',
        workspaceCwd: join(storageRoot, 'ignored')
      })
    ).resolves.toBeNull()
  })
})

const makeRunRecord = (overrides: Partial<NotebookRunRecord> = {}): NotebookRunRecord => ({
  runId: 'run-1',
  cellId: 'cell-1',
  source: 'agent',
  kernelKind: 'python',
  script: 'df = load()',
  status: 'completed',
  startedAt: 100,
  endedAt: 200,
  text: { stdout: '', stderr: '', traceback: '', plain: [] },
  outputs: [],
  artifacts: [],
  workingFiles: [],
  ...overrides
})

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

// v2.1.0 batch B: a run recorded before the risk receipt existed still carries its source, so the
// content hash the lineage recipe asks for is recomputable on read. These cases hold the two rules
// that keep the completion honest: it equals the published recipe's value (hashed independently in
// the test), and it is never persisted as if the run had been written with it.
describe('read-side content hash for records that predate the receipt', () => {
  const withRun = async (
    run: NotebookRunRecord
  ): Promise<{
    state: Awaited<ReturnType<NotebookSessionReadModel<NotebookSessionReadSource>['state']>>
    storageRoot: string
    session: NotebookSessionReadSource
  }> => {
    const storageRoot = await createRoot()
    const repository = new NotebookRunRepository(storageRoot)
    const session = makeSession(storageRoot)
    await repository.loadOrCreate({
      projectName: session.projectName,
      sessionId: session.sessionId,
      workspaceCwd: session.cwd
    })
    await repository.appendRun({
      projectName: session.projectName,
      sessionId: session.sessionId,
      run
    })

    return {
      state: await makeReadModel(storageRoot, session, repository).state(session),
      storageRoot,
      session
    }
  }

  it('derives the published recipe’s sha256, and keeps it off the persisted record', async () => {
    const { state, storageRoot, session } = await withRun(makeRunRecord({ script: 'df = load()' }))

    // Hashed here the way a third party would, from the recorded source.
    expect(state.runs[0]?.sourceContentHash).toEqual({
      value: sha256('df = load()'),
      provenance: 'computed-on-read'
    })
    expect(state.recentRuns[0]?.sourceContentHash).toEqual(state.runs[0]?.sourceContentHash)

    // Derived on read only: run.json stays free of it, so a computation is never mistaken for
    // something the run was written with — and `riskReview` stays absent (this run was not assessed).
    const onDisk = await readFile(
      getNotebookRunJsonPath(storageRoot, session.projectName, session.sessionId),
      'utf8'
    )
    expect(onDisk).not.toContain('sourceContentHash')
    expect(onDisk).not.toContain('computed-on-read')
    expect(onDisk).not.toContain('riskReview')
  })

  it('leaves the field off when the run carries its own receipt, so no run quotes two hashes', async () => {
    const { state } = await withRun(
      makeRunRecord({
        riskReview: {
          verdict: 'allow',
          ruleSetVersion: 'notebook-run-risk:v1',
          codeHash: sha256('df = load()'),
          hits: []
        }
      })
    )

    expect(state.runs[0]?.sourceContentHash).toBeUndefined()
    expect(state.runs[0]?.riskReview?.codeHash).toBe(sha256('df = load()'))
  })

  it('does not invent a hash for a record with no source to hash', async () => {
    const { state } = await withRun(makeRunRecord({ script: '' }))

    expect(state.runs[0]?.sourceContentHash).toBeUndefined()
  })
})
