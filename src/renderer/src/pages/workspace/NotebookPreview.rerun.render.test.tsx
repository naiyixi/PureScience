// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  NotebookEnvironmentStatus,
  NotebookRunRecord,
  NotebookSessionState
} from '../../../../shared/notebook'
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

const makeRun = (overrides: Partial<NotebookRunRecord> = {}): NotebookRunRecord => ({
  runId: 'r1',
  cellId: 'c1',
  source: 'agent',
  kernelKind: 'python',
  script: 'print(1)',
  status: 'completed',
  startedAt: 0,
  text: { stdout: '', stderr: '', traceback: '', plain: [] },
  outputs: [],
  artifacts: [],
  workingFiles: [],
  ...overrides
})

const readyStatus: ProvisionStatus = {
  pythonReady: true,
  rReady: false,
  version: 1,
  provisioning: false
}

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

// Mounts the real pane over a given session state. Every turn is a real macrotask because the pane
// defers its first load and React's passive effects queue the same way in this environment.
const mount = async (
  runs: NotebookRunRecord[],
  state: Partial<NotebookSessionState> = {},
  environments: NotebookEnvironmentStatus[] = []
): Promise<{ runCell: ReturnType<typeof vi.fn> }> => {
  const runCell = vi.fn(async () => ({ runId: 'r2', status: 'completed' }))
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
          environments,
          ...state
        })
      ),
      onChanged: vi.fn(() => vi.fn()),
      runCell
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

  return { runCell }
}

const rerunButtons = (): HTMLButtonElement[] =>
  Array.from(container.querySelectorAll('[data-testid="notebook-cell-rerun"]'))

const clickRerun = async (index = 0): Promise<void> => {
  const button = rerunButtons()[index]
  expect(button).toBeDefined()
  await act(async () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

describe('NotebookPreview cell re-run', () => {
  it('re-runs the cell of that row as the user, in the environment the run used', async () => {
    const { runCell } = await mount([
      makeRun({ runId: 'p1', cellId: 'c1', environment: 'my-analysis', script: 'print(1)' })
    ])

    expect(rerunButtons().length).toBe(1)
    await clickRerun()

    expect(runCell).toHaveBeenCalledTimes(1)
    expect(runCell.mock.calls[0][0]).toEqual({
      sessionId: 'session-1',
      projectName: 'proj',
      workspaceCwd: '/tmp/proj',
      cellId: 'c1',
      source: 'user',
      environment: 'my-analysis'
    })

    // The receipt names the engine's own status, so the outcome is attributable to this action.
    const notice = container.querySelector('[data-testid="notebook-rerun-summary"]')
    expect(notice?.textContent).toContain('completed')
  })

  it('keeps a legacy python run in the default environment instead of dropping the field', async () => {
    const { runCell } = await mount([makeRun({ runId: 'p1', cellId: 'c1' })])

    await clickRerun()

    // A run without an explicit environment ran in the kind's default one; re-running must stay there
    // rather than let the engine pick again.
    expect((runCell.mock.calls[0][0] as { environment?: string }).environment).toBe(
      'default-python'
    )
  })

  it('sends no environment for a kernel kind that is not env-scoped', async () => {
    const { runCell } = await mount([
      makeRun({ runId: 'b1', cellId: 'c9', kernelKind: 'bash', script: 'ls -la' })
    ])

    await clickRerun()

    const payload = runCell.mock.calls[0][0] as Record<string, unknown>
    expect(payload.cellId).toBe('c9')
    // Not "environment: undefined" — the key must be absent for repl/bash, which have no named envs.
    expect(Object.keys(payload)).not.toContain('environment')
  })

  it('re-runs only the cell of the row that was clicked', async () => {
    const { runCell } = await mount([
      makeRun({ runId: 'p1', cellId: 'c1', script: 'print(1)' }),
      makeRun({ runId: 'p2', cellId: 'c2', script: 'print(2)' })
    ])

    expect(rerunButtons().length).toBe(2)
    await clickRerun(1)

    expect((runCell.mock.calls[0][0] as { cellId: string }).cellId).toBe('c2')
  })

  it('disables every row and says why while another run is in flight', async () => {
    const { runCell } = await mount([makeRun({ runId: 'p1', cellId: 'c1' })], {
      activeRunId: 'run-9'
    })

    const button = rerunButtons()[0]
    expect(button.disabled).toBe(true)
    const reason = container.querySelector('[data-testid="notebook-cell-rerun-blocked"]')
    expect(reason?.textContent).toContain('run is already in flight')

    await clickRerun()
    expect(runCell).not.toHaveBeenCalled()
  })

  it('blocks only the cell the agent is still writing', async () => {
    await mount(
      [
        makeRun({ runId: 'p1', cellId: 'c1', script: 'print(1)' }),
        makeRun({ runId: 'p2', cellId: 'c2', script: 'print(2)' })
      ],
      {
        activeWrite: { writeId: 'w1', cellId: 'c1', source: 'agent', startedAt: 0 }
      }
    )

    const [blocked, free] = rerunButtons()
    expect(blocked.disabled).toBe(true)
    expect(
      container.querySelectorAll('[data-testid="notebook-cell-rerun-blocked"]')[0]?.textContent
    ).toContain('still streaming code')
    // A neighbouring cell is unaffected: the reason is per cell, not a blanket shutdown.
    expect(free.disabled).toBe(false)
  })

  it('shows the pane gate reason instead of a runnable control while the environment is missing', async () => {
    const missing: ProvisionStatus = {
      pythonReady: false,
      rReady: false,
      version: 1,
      provisioning: false
    }
    useNotebookEnvStore.setState({
      status: missing,
      ui: deriveProvisionUi(missing, undefined, undefined, undefined)
    })
    const { runCell } = await mount([makeRun({ runId: 'p1', cellId: 'c1' })])

    const button = rerunButtons()[0]
    expect(button.disabled).toBe(true)
    expect(
      container.querySelector('[data-testid="notebook-cell-rerun-blocked"]')?.textContent
    ).toContain('environment is still being prepared')

    await clickRerun()
    expect(runCell).not.toHaveBeenCalled()
  })
})
