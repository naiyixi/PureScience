// @vitest-environment jsdom
import { createHash } from 'node:crypto'

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { NotebookRunRecord, NotebookSessionState } from '../../../../shared/notebook'
import type { ProvisionStatus } from '../../../../shared/notebook-env'
import { useNotebookEnvStore } from '../../stores/notebook-env-store'
import { NotebookPreview, type NotebookPreviewItem } from './NotebookPreview'
import { deriveProvisionUi } from './provisioning-view'

vi.mock('./notebook-code', () => ({
  NotebookCodeBlock: (props: { code: string }) => (
    <pre data-testid="notebook-code-block">{props.code}</pre>
  )
}))

const item: NotebookPreviewItem = {
  id: 'tool:notebook:test-session',
  sessionId: 'session-1',
  title: 'Notebook',
  type: 'tool',
  toolKind: 'notebook',
  notebook: {
    sessionId: 'session-1',
    projectName: 'proj',
    workspaceCwd: '/tmp/proj',
    notebookSessionRoot: '/tmp/proj/.notebook',
    dataRoot: '/tmp/proj/.notebook/data',
    runtimeRoot: '/tmp/proj/.notebook/runtime',
    runJsonPath: '/tmp/proj/.notebook/run.json'
  }
}

const readyStatus: ProvisionStatus = {
  pythonReady: true,
  rReady: false,
  version: 1,
  provisioning: false
}

// The producing run writes `df`; the later run only ever mentions `frame`, which it bound to `df` and
// then changed in place. The recorded writer lists therefore never overlap, so nothing at all flags
// the first run under the name-level rule — this pane is the only surface that can say what happened.
const producingRun = (overrides: Partial<NotebookRunRecord> = {}): NotebookRunRecord => ({
  runId: 'run-a',
  cellId: 'cell-a',
  source: 'agent',
  kernelKind: 'python',
  script: 'df = load()',
  status: 'completed',
  variablesWritten: ['df'],
  startedAt: 0,
  text: { stdout: '', stderr: '', traceback: '', plain: [] },
  outputs: [],
  artifacts: [],
  workingFiles: [],
  ...overrides
})

const mutatingRun = (overrides: Partial<NotebookRunRecord> = {}): NotebookRunRecord => ({
  runId: 'run-b',
  cellId: 'cell-b',
  source: 'agent',
  kernelKind: 'python',
  script: 'frame = df\nframe.dropna(inplace=True)',
  status: 'completed',
  variablesWritten: ['frame'],
  startedAt: 0,
  text: { stdout: '', stderr: '', traceback: '', plain: [] },
  outputs: [],
  artifacts: [],
  workingFiles: [],
  ...overrides
})

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  useNotebookEnvStore.setState({
    status: readyStatus,
    ui: deriveProvisionUi(readyStatus, undefined, undefined, undefined)
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const mount = async (runs: NotebookRunRecord[]): Promise<void> => {
  window.api = {
    notebook: {
      state: vi.fn(() =>
        Promise.resolve({
          id: 'session-1',
          sessionId: 'session-1',
          cwd: '/tmp/proj',
          notebookSessionRoot: '/tmp/proj/.notebook',
          dataRoot: '/tmp/proj/.notebook/data',
          runtimeRoot: '/tmp/proj/.notebook/runtime',
          kernelStatus: 'idle',
          runJsonPath: '/tmp/proj/.notebook/run.json',
          cells: [],
          runs,
          recentRuns: runs,
          environments: []
        } satisfies Partial<NotebookSessionState>)
      ),
      onChanged: vi.fn(() => vi.fn()),
      runCell: vi.fn()
    },
    notebookEnv: {
      getStatus: vi.fn(() => Promise.resolve(readyStatus)),
      provision: vi.fn(() => Promise.resolve()),
      onProgress: vi.fn(() => vi.fn())
    }
  } as never

  await act(async () => {
    root.render(<NotebookPreview item={item} />)
  })
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

const reasonElement = (): HTMLElement | null =>
  container.querySelector('[data-testid="notebook-cell-stale-reason"]')

const staleMarkers = (): Element[] =>
  Array.from(container.querySelectorAll('[data-testid="notebook-cell-stale"]'))

describe('NotebookPreview stale-run reason', () => {
  it('explains a change made through an alias, and carries the facts it was derived from', async () => {
    await mount([
      producingRun({
        riskReview: {
          verdict: 'allow',
          ruleSetVersion: 'notebook-run-risk:v1',
          codeHash: 'b'.repeat(64),
          hits: []
        }
      }),
      mutatingRun()
    ])

    expect(staleMarkers()).toHaveLength(1)
    const reason = reasonElement()
    expect(reason).not.toBeNull()
    expect(reason?.textContent).toBe(
      '“df” was changed in place by a later run through the alias “frame” (line 2)'
    )
    // Every field of the reason is on the element, so the sentence can be checked against run.json.
    expect(reason?.getAttribute('data-recipe')).toBe('notebook-alias-lineage:v1')
    expect(reason?.getAttribute('data-variable')).toBe('df')
    expect(reason?.getAttribute('data-via')).toBe('frame')
    expect(reason?.getAttribute('data-alias-chain')).toBe('frame')
    expect(reason?.getAttribute('data-later-run')).toBe('run-b')
    expect(reason?.getAttribute('data-mutation-kind')).toBe('inplace-call')
    expect(reason?.getAttribute('data-line')).toBe('2')
    expect(reason?.getAttribute('data-content-hash')).toBe('b'.repeat(64))
    expect(reason?.getAttribute('title')).toBe('frame.dropna(inplace=True)')
  })

  it('states a missing content hash instead of a stand-in value', async () => {
    await mount([producingRun(), mutatingRun()])

    expect(reasonElement()?.getAttribute('data-content-hash')).toBe('not-recorded')
  })

  it('shows the hash a reader computed for a run that predates the receipt', async () => {
    const script = 'df = load()'
    // Hashed here the way a third party would, from the run's own source — not read back from the app.
    const independent = createHash('sha256').update(script, 'utf8').digest('hex')
    await mount([
      producingRun({ sourceContentHash: { value: independent, provenance: 'computed-on-read' } }),
      mutatingRun()
    ])

    expect(reasonElement()?.getAttribute('data-content-hash')).toBe(independent)
  })

  it('keeps the marker and stays silent when the change cannot be located', async () => {
    // The name-level rule flags the first run (a later run wrote `df`), but that later run has no
    // recorded script, so there is no site to name. The marker stays; no reason is invented.
    await mount([
      producingRun(),
      producingRun({
        runId: 'run-c',
        cellId: 'cell-c',
        script: undefined,
        variablesWritten: ['df']
      })
    ])

    expect(staleMarkers()).toHaveLength(1)
    expect(reasonElement()).toBeNull()
  })

  it('does not treat a copy as an alias, so a copied frame keeps the earlier run fresh', async () => {
    await mount([
      producingRun(),
      mutatingRun({ script: 'frame = df.copy()\nframe.dropna(inplace=True)' })
    ])

    expect(staleMarkers()).toHaveLength(0)
    expect(reasonElement()).toBeNull()
  })
})
