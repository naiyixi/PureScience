// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { NotebookEnvironmentStatus, NotebookRunRecord } from '../../../../shared/notebook'
import type { ProvisionStatus } from '../../../../shared/notebook-env'
import { createInitialNotebookEnvState, useNotebookEnvStore } from '../../stores/notebook-env-store'
import { EnvProvisionOverlay } from './EnvProvisionOverlay'
import { NotebookPreview, type NotebookPreviewItem } from './NotebookPreview'
import { deriveProvisionUi } from './provisioning-view'

const notebookCodeBlockSpy = vi.hoisted(() => vi.fn())
// Records what the gate overlay's Cancel control asks the main process to abort.
const notebookEnvCancelSpy = vi.hoisted(() => vi.fn(() => Promise.resolve()))

vi.mock('./notebook-code', () => ({
  NotebookCodeBlock: (props: { code: string; language?: string; highlightLine?: number }) => {
    notebookCodeBlockSpy(props)
    return <pre data-testid="notebook-code-block">{props.code}</pre>
  }
}))

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  notebookCodeBlockSpy.mockClear()
  notebookEnvCancelSpy.mockClear()
  useNotebookEnvStore.setState(createInitialNotebookEnvState())
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('EnvProvisionOverlay', () => {
  it('shows the python preparation message and progress', () => {
    const ui = deriveProvisionUi(
      { pythonReady: false, rReady: false, version: 3, provisioning: true },
      'python',
      { phase: 'materialize', message: 'Preparing Python environment…', progress: 0.5 },
      undefined
    )
    act(() => root.render(<EnvProvisionOverlay ui={ui} />))
    const gate = container.querySelector('[data-testid="notebook-env-gate"]')
    expect(gate?.textContent).toContain('Preparing Python environment')
  })

  it('renders a retry affordance in the error state', () => {
    let retried = 0
    act(() =>
      root.render(
        <EnvProvisionOverlay
          ui={{ kind: 'error', message: 'offline' }}
          onRetry={() => (retried += 1)}
        />
      )
    )
    const button = container.querySelector(
      '[data-testid="notebook-env-retry"]'
    ) as HTMLButtonElement
    expect(button).not.toBeNull()
    act(() => button.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(retried).toBe(1)
  })

  it('renders nothing when ready', () => {
    act(() => root.render(<EnvProvisionOverlay ui={{ kind: 'ready' }} />))
    expect(container.querySelector('[data-testid="notebook-env-gate"]')).toBeNull()
  })

  it('offers Cancel while preparing when the caller can abort the run', () => {
    let cancelled = 0
    const ui = deriveProvisionUi(
      { pythonReady: false, rReady: false, version: 3, provisioning: true },
      'python',
      { phase: 'download', message: 'Downloading managed python runtime', progress: 0.25 },
      undefined
    )
    act(() => root.render(<EnvProvisionOverlay ui={ui} onCancel={() => (cancelled += 1)} />))
    const button = container.querySelector(
      '[data-testid="notebook-env-cancel"]'
    ) as HTMLButtonElement
    expect(button).not.toBeNull()
    act(() => button.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(cancelled).toBe(1)
  })

  it('draws no Cancel when the caller passes no abort handler (additive upgrade)', () => {
    const ui = deriveProvisionUi(
      { pythonReady: true, rReady: false, version: 3, provisioning: true },
      undefined,
      { phase: 'upgrade', message: 'Updating default packages…', progress: 0.1, scope: 'upgrade' },
      undefined
    )
    act(() => root.render(<EnvProvisionOverlay ui={ui} />))
    expect(container.querySelector('[data-testid="notebook-env-gate"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="notebook-env-cancel"]')).toBeNull()
  })
})

// D3-review recipe: mount the real NotebookPreview with a never-resolving notebook.state() (so it
// stays perpetually loading/inert) and assert the gate tracks useNotebookEnvStore state directly,
// proving the gate wiring survives inside the actual pane rather than only in EnvProvisionOverlay
// isolation above.
describe('NotebookPreview env gate (mounted)', () => {
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

  beforeEach(() => {
    window.api = {
      notebook: {
        // Never resolves, so the pane stays inert for the duration of the test.
        state: vi.fn(() => new Promise(() => {})),
        onChanged: vi.fn(() => vi.fn())
      },
      notebookEnv: {
        getStatus: vi.fn(() => Promise.resolve(createInitialNotebookEnvState().status)),
        provision: vi.fn(() => Promise.resolve()),
        cancel: notebookEnvCancelSpy,
        onProgress: vi.fn(() => vi.fn())
      }
    } as never
  })

  it('cancels the in-flight python provision from the gate overlay', async () => {
    const preparingStatus: ProvisionStatus = {
      pythonReady: false,
      rReady: false,
      version: 1,
      provisioning: true
    }
    useNotebookEnvStore.setState({
      status: preparingStatus,
      scope: 'python',
      ui: deriveProvisionUi(
        preparingStatus,
        'python',
        {
          phase: 'download',
          message: 'Downloading managed python runtime',
          progress: 0.25,
          scope: 'python'
        },
        undefined
      )
    })

    act(() => root.render(<NotebookPreview item={item} />))
    const button = container.querySelector(
      '[data-testid="notebook-env-cancel"]'
    ) as HTMLButtonElement
    expect(button).not.toBeNull()

    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    // The language is forwarded, so cancelling the frozen pane never aborts the other language's run.
    expect(notebookEnvCancelSpy).toHaveBeenCalledWith('python')
  })

  it('offers no cancel while an additive upgrade holds the pane', () => {
    const upgradingStatus: ProvisionStatus = {
      pythonReady: true,
      rReady: false,
      version: 1,
      provisioning: true
    }
    useNotebookEnvStore.setState({
      status: upgradingStatus,
      ui: deriveProvisionUi(
        upgradingStatus,
        undefined,
        {
          phase: 'upgrade',
          message: 'Updating default packages…',
          progress: 0.1,
          scope: 'upgrade'
        },
        undefined
      )
    })

    act(() => root.render(<NotebookPreview item={item} />))
    expect(container.querySelector('[data-testid="notebook-env-gate"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="notebook-env-cancel"]')).toBeNull()
    expect(notebookEnvCancelSpy).not.toHaveBeenCalled()
  })

  it('shows notebook-env-gate while preparing and hides it once python is ready', () => {
    const preparingStatus: ProvisionStatus = {
      pythonReady: false,
      rReady: false,
      version: 1,
      provisioning: true
    }
    useNotebookEnvStore.setState({
      status: preparingStatus,
      ui: deriveProvisionUi(preparingStatus, undefined, undefined, undefined)
    })

    act(() => root.render(<NotebookPreview item={item} />))
    expect(container.querySelector('[data-testid="notebook-env-gate"]')).not.toBeNull()

    const readyStatus: ProvisionStatus = {
      pythonReady: true,
      rReady: false,
      version: 1,
      provisioning: false
    }
    act(() => {
      useNotebookEnvStore.setState({
        status: readyStatus,
        ui: deriveProvisionUi(readyStatus, undefined, undefined, undefined)
      })
    })

    expect(container.querySelector('[data-testid="notebook-env-gate"]')).toBeNull()
  })

  it('does not cover this notebook for another session provisioning run', () => {
    const preparingStatus: ProvisionStatus = {
      pythonReady: false,
      rReady: false,
      version: 1,
      provisioning: true
    }
    useNotebookEnvStore.setState({
      status: preparingStatus,
      ui: deriveProvisionUi(
        preparingStatus,
        undefined,
        {
          phase: 'download',
          message: 'Downloading managed python runtime',
          progress: 0.25,
          scope: 'python',
          sessionId: 'session-2'
        },
        undefined
      )
    })

    act(() => root.render(<NotebookPreview item={item} />))

    expect(container.querySelector('[data-testid="notebook-env-gate"]')).toBeNull()
  })

  it('only covers the session whose automatic Python preparation failed', () => {
    const failedStatus: ProvisionStatus = {
      pythonReady: false,
      rReady: false,
      version: 1,
      provisioning: false
    }
    const failedProgress = {
      phase: 'error',
      message: 'Python download failed',
      progress: 0,
      scope: 'python' as const
    }
    useNotebookEnvStore.setState({
      status: failedStatus,
      ui: deriveProvisionUi(
        failedStatus,
        undefined,
        { ...failedProgress, sessionId: 'session-2' },
        failedProgress.message
      )
    })

    act(() => root.render(<NotebookPreview item={item} />))
    expect(container.querySelector('[data-testid="notebook-env-gate"]')).toBeNull()

    act(() => {
      useNotebookEnvStore.setState({
        ui: deriveProvisionUi(
          failedStatus,
          undefined,
          { ...failedProgress, sessionId: 'session-1' },
          failedProgress.message
        )
      })
    })
    expect(container.querySelector('[data-testid="notebook-env-gate"]')).not.toBeNull()
  })
})

// Minimal NotebookRunRecord builder, mirroring SessionNotebookDialog.render.test.tsx's makeRun.
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

describe('NotebookPreview per-kernel tabs', () => {
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

  const mountWithRuns = async (
    runs: NotebookRunRecord[],
    environments: NotebookEnvironmentStatus[] = []
  ): Promise<void> => {
    const readyStatus: ProvisionStatus = {
      pythonReady: true,
      rReady: false,
      version: 1,
      provisioning: false
    }
    useNotebookEnvStore.setState({
      status: readyStatus,
      ui: deriveProvisionUi(readyStatus, undefined, undefined, undefined)
    })

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
            environments
          })
        ),
        onChanged: vi.fn(() => vi.fn())
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
    // Flush the mount-deferred setTimeout(0) that kicks off loadNotebookState(), plus its state()
    // promise resolution and the resulting re-render — React's passive effects also queue via a
    // macrotask in this jsdom test environment, so this needs a few real event-loop turns.
    for (let i = 0; i < 5; i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
    }
  }

  it('shows a tab only for kernel kinds present in the runs (no default python/r tab)', async () => {
    await mountWithRuns([
      makeRun({ runId: 'p1', kernelKind: 'python' }),
      makeRun({ runId: 'x1', kernelKind: 'repl', script: 'await host.notebook.run(...)' }),
      makeRun({ runId: 'b1', kernelKind: 'bash', script: 'ls -la' })
    ])

    const switcher = container.querySelector('[data-testid="kernel-switcher"]') as HTMLElement
    expect(switcher.querySelector('[data-testid="kernel-switcher-python"]')).not.toBeNull()
    expect(switcher.querySelector('[data-testid="kernel-switcher-repl"]')?.textContent).toBe(
      'Agent SDK'
    )
    expect(switcher.querySelector('[data-testid="kernel-switcher-bash"]')?.textContent).toBe('Bash')
    // R produced no run here, so its tab does not appear (it shows up only once R is used).
    expect(switcher.querySelector('[data-testid="kernel-switcher-r"]')).toBeNull()
  })

  it('shows the R tab only once R has produced a run', async () => {
    await mountWithRuns([
      makeRun({ runId: 'p1', kernelKind: 'python' }),
      makeRun({ runId: 'r1', kernelKind: 'r', script: 'print(1)' })
    ])

    const switcher = container.querySelector('[data-testid="kernel-switcher"]') as HTMLElement
    expect(switcher.querySelector('[data-testid="kernel-switcher-r"]')).not.toBeNull()
  })

  it('shows no Agent SDK/Bash tab for a python-only run set', async () => {
    await mountWithRuns([
      makeRun({ runId: 'p1', kernelKind: 'python' }),
      makeRun({ runId: 'p2', kernelKind: 'python' })
    ])

    const switcher = container.querySelector('[data-testid="kernel-switcher"]') as HTMLElement
    expect(switcher.querySelector('[data-testid="kernel-switcher-repl"]')).toBeNull()
    expect(switcher.querySelector('[data-testid="kernel-switcher-bash"]')).toBeNull()
  })

  it("shows only the active kind's cells, and switches on tab click", async () => {
    await mountWithRuns([
      makeRun({ runId: 'p1', kernelKind: 'python', script: 'print("py")' }),
      makeRun({ runId: 'x1', kernelKind: 'repl', script: 'host.notebook.run(...)' })
    ])

    expect(container.querySelectorAll('[data-testid="notebook-cell"]').length).toBe(1)
    expect(container.textContent).toContain('print("py")')
    expect(container.textContent).not.toContain('host.notebook.run')

    const replTab = container.querySelector(
      '[data-testid="kernel-switcher-repl"]'
    ) as HTMLButtonElement
    act(() => replTab.dispatchEvent(new MouseEvent('click', { bubbles: true })))

    expect(container.querySelectorAll('[data-testid="notebook-cell"]').length).toBe(1)
    expect(container.textContent).toContain('host.notebook.run')
    expect(container.textContent).not.toContain('print("py")')
  })

  it('defaults to the Agent SDK tab and shows no R tab when only repl runs exist', async () => {
    await mountWithRuns([
      makeRun({ runId: 'x1', kernelKind: 'repl', script: 'host.notebook.run(...)' })
    ])

    // No tab click: this is the pre-click default state. repl is the only kind with runs, so it is
    // the active tab; python and R have no runs, so neither tab is shown.
    const switcher = container.querySelector('[data-testid="kernel-switcher"]') as HTMLElement
    const replTab = switcher.querySelector(
      '[data-testid="kernel-switcher-repl"]'
    ) as HTMLButtonElement
    expect(switcher.querySelector('[data-testid="kernel-switcher-r"]')).toBeNull()
    expect(switcher.querySelector('[data-testid="kernel-switcher-python"]')).toBeNull()
    expect(replTab.className).toContain('bg-bg-300')

    expect(container.querySelectorAll('[data-testid="notebook-cell"]').length).toBe(1)
    expect(container.textContent).toContain('host.notebook.run')
  })

  it("renders a repl cell's origin label and uses the stored kernelKind for the language chip", async () => {
    await mountWithRuns([makeRun({ runId: 'x1', kernelKind: 'repl', script: 'x <- 1' })])

    const replTab = container.querySelector(
      '[data-testid="kernel-switcher-repl"]'
    ) as HTMLButtonElement
    act(() => replTab.dispatchEvent(new MouseEvent('click', { bubbles: true })))

    const cell = container.querySelector('[data-testid="notebook-cell"]') as HTMLElement
    expect(cell).not.toBeNull()
    // Stored kernelKind ('repl') wins over the R-looking script's detectCellLanguage heuristic.
    expect(cell.textContent).toContain('repl')
    expect(cell.querySelector('[data-testid="notebook-cell-origin"]')?.textContent).toBe('repl')
  })

  it('passes the active kernel language to notebook code blocks', async () => {
    await mountWithRuns([
      makeRun({ runId: 'p1', kernelKind: 'python', script: 'import pandas as pd' }),
      makeRun({ runId: 'r1', kernelKind: 'r', script: 'library(ggplot2)' }),
      makeRun({ runId: 'b1', kernelKind: 'bash', script: 'ls -la' }),
      makeRun({ runId: 'x1', kernelKind: 'repl', script: 'await host.notebook.run()' })
    ])

    expect(notebookCodeBlockSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ code: 'import pandas as pd', language: 'python' })
    )

    const clickTab = (testId: string): void => {
      const tab = container.querySelector(`[data-testid="${testId}"]`) as HTMLButtonElement
      act(() => tab.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    }

    clickTab('kernel-switcher-r')
    expect(notebookCodeBlockSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ code: 'library(ggplot2)', language: 'r' })
    )

    clickTab('kernel-switcher-bash')
    expect(notebookCodeBlockSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ code: 'ls -la', language: 'bash' })
    )

    clickTab('kernel-switcher-repl')
    expect(notebookCodeBlockSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ code: 'await host.notebook.run()', language: 'javascript' })
    )
  })
})

describe('NotebookPreview per-environment selector', () => {
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

  const mountWithRuns = async (
    runs: NotebookRunRecord[],
    environments: NotebookEnvironmentStatus[] = []
  ): Promise<void> => {
    const readyStatus: ProvisionStatus = {
      pythonReady: true,
      rReady: false,
      version: 1,
      provisioning: false
    }
    useNotebookEnvStore.setState({
      status: readyStatus,
      ui: deriveProvisionUi(readyStatus, undefined, undefined, undefined)
    })

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
            environments
          })
        ),
        onChanged: vi.fn(() => vi.fn())
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

  it('shows no env selector and all runs visible for single-env python runs (unchanged UX)', async () => {
    await mountWithRuns([
      makeRun({
        runId: 'p1',
        kernelKind: 'python',
        script: 'print(1)',
        environment: 'default-python'
      }),
      makeRun({
        runId: 'p2',
        kernelKind: 'python',
        script: 'print(2)',
        environment: 'default-python'
      })
    ])

    expect(container.querySelector('[data-testid="env-selector"]')).toBeNull()
    expect(container.querySelectorAll('[data-testid="notebook-cell"]').length).toBe(2)
  })

  it('shows the selector across two python envs, defaults labeled "default", and filters on selection', async () => {
    await mountWithRuns([
      makeRun({ runId: 'p1', kernelKind: 'python', script: 'print("default")' }),
      makeRun({
        runId: 'p2',
        kernelKind: 'python',
        script: 'print("analysis")',
        environment: 'my-analysis'
      })
    ])

    const selector = container.querySelector('[data-testid="env-selector"]') as HTMLElement
    expect(selector).not.toBeNull()

    const defaultOption = selector.querySelector(
      '[data-testid="env-option-default-python"]'
    ) as HTMLButtonElement
    const analysisOption = selector.querySelector(
      '[data-testid="env-option-my-analysis"]'
    ) as HTMLButtonElement
    expect(defaultOption.textContent).toContain('default')
    expect(analysisOption.textContent).toContain('my-analysis')

    // Default env selected initially (default-first ordering).
    expect(container.querySelectorAll('[data-testid="notebook-cell"]').length).toBe(1)
    expect(container.textContent).toContain('print("default")')
    expect(container.textContent).not.toContain('print("analysis")')

    act(() => analysisOption.dispatchEvent(new MouseEvent('click', { bubbles: true })))

    expect(container.querySelectorAll('[data-testid="notebook-cell"]').length).toBe(1)
    expect(container.textContent).toContain('print("analysis")')
    expect(container.textContent).not.toContain('print("default")')
  })

  it('groups a legacy run with no environment field under default-python', async () => {
    await mountWithRuns([
      makeRun({
        runId: 'p1',
        kernelKind: 'python',
        script: 'print("legacy")',
        environment: undefined
      }),
      makeRun({
        runId: 'p2',
        kernelKind: 'python',
        script: 'print("analysis")',
        environment: 'my-analysis'
      })
    ])

    const selector = container.querySelector('[data-testid="env-selector"]') as HTMLElement
    expect(selector.querySelector('[data-testid="env-option-default-python"]')).not.toBeNull()

    // Legacy run (no `environment`) is visible under the default-python option, selected by default.
    expect(container.textContent).toContain('print("legacy")')
    expect(container.textContent).not.toContain('print("analysis")')
  })

  it('shows a per-env status badge derived from state().environments', async () => {
    await mountWithRuns(
      [
        makeRun({ runId: 'p1', kernelKind: 'python', script: 'print(1)' }),
        makeRun({
          runId: 'p2',
          kernelKind: 'python',
          script: 'print(2)',
          environment: 'my-analysis'
        })
      ],
      [
        {
          processKey: 'python:default-python',
          kind: 'python',
          environment: 'default-python',
          status: 'idle'
        },
        {
          processKey: 'python:my-analysis',
          kind: 'python',
          environment: 'my-analysis',
          status: 'running'
        }
      ]
    )

    const analysisBadge = container.querySelector(
      '[data-testid="env-option-my-analysis-status"]'
    ) as HTMLElement
    expect(analysisBadge).not.toBeNull()
    expect(analysisBadge.className).toContain('bg-accent')
  })
})

// IC14: the session's runtime binding surface. Every assertion here is about what the WINDOW does with
// the main process's answer — the binding it asks for, and the reason it shows when the bound runtime
// cannot back a kernel.
describe('NotebookPreview runtime binding (IC14)', () => {
  const item: NotebookPreviewItem = {
    id: 'tool:notebook:runtime-session',
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

  const managed = {
    language: 'python' as const,
    runtimeId: 'managed:default-python',
    source: 'managed' as const,
    provenance: 'app-managed' as const,
    interpreterPath: '/runtime/envs/default-python/bin/python',
    label: 'Python 3.12 (managed)'
  }
  const external = {
    language: 'python' as const,
    runtimeId: 'external:/opt/py/bin/python',
    source: 'external' as const,
    provenance: 'user-own' as const,
    interpreterPath: '/opt/py/bin/python',
    label: 'System Python'
  }

  let listRuntimes: ReturnType<typeof vi.fn>
  let bindRuntime: ReturnType<typeof vi.fn>
  let switchRuntime: ReturnType<typeof vi.fn>
  let responses: Array<{ runtimes: unknown[]; bindings: unknown }>
  let listCalls: number

  beforeEach(() => {
    responses = []
    listCalls = 0
    // First call answers the BEFORE state, every later call the AFTER state — so the test can prove the
    // row is re-read from the app rather than patched locally.
    listRuntimes = vi.fn(async () => {
      const index = Math.min(listCalls, responses.length - 1)
      listCalls += 1
      return responses[Math.max(0, index)]
    })
    bindRuntime = vi.fn(async () => ({ bound: external, bindings: { python: external } }))
    switchRuntime = vi.fn(async () => ({ bound: managed, bindings: { python: managed } }))
    window.api = {
      notebook: {
        listRuntimes,
        bindRuntime,
        switchRuntime,
        // The pane subscribes to the session's change stream on mount; the double answers with a no-op
        // unsubscribe so the render never depends on a real event source.
        onChanged: () => () => {},
        onAvailable: () => () => {}
      }
    } as unknown as typeof window.api
  })

  it('lists the enabled runtimes, marks the bound one, then binds once and switches afterwards', async () => {
    responses = [
      // Nothing explicitly bound: this language still resolves to the app-managed default.
      {
        runtimes: [
          { ...managed, runnable: true, bound: true },
          { ...external, runnable: true, bound: false }
        ],
        bindings: {}
      },
      // After the write the row's truth comes from the app, not from local patching.
      {
        runtimes: [
          { ...managed, runnable: true, bound: false },
          { ...external, runnable: true, bound: true }
        ],
        bindings: { python: external }
      }
    ]

    await act(async () => {
      root.render(<NotebookPreview item={item} />)
    })
    await act(async () => {})
    // The listing is loaded on a deferred timeout, so flush that phase before reading the row.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    const strip = container.querySelector('[data-testid="notebook-runtime-binding"]')
    expect(strip?.textContent).toContain('Python 3.12 (managed)')
    expect(strip?.textContent).toContain('System Python')
    expect(strip?.textContent).toContain('in use')

    const option = container.querySelector(
      `[data-testid="notebook-runtime-option-${external.runtimeId}"]`
    ) as HTMLButtonElement
    await act(async () => option.dispatchEvent(new MouseEvent('click', { bubbles: true })))

    // The FIRST explicit choice is a bind — and it names the session and the runtime the user picked.
    expect(bindRuntime).toHaveBeenCalledWith({
      sessionId: 'session-1',
      workspaceCwd: '/tmp/proj',
      projectName: 'proj',
      language: 'python',
      runtimeId: external.runtimeId
    })
    expect(switchRuntime).not.toHaveBeenCalled()
    // The listing was re-read, so the row now reflects the app's answer.
    expect(listRuntimes.mock.calls.length).toBeGreaterThan(1)
    expect(
      container.querySelector('[data-testid="notebook-runtime-binding"]')?.textContent
    ).toContain('in use')

    // Once an explicit binding exists, a different runtime needs a SWITCH (the main process refuses a
    // second bind, and a switch tears the old kernel down first).
    const other = container.querySelector(
      `[data-testid="notebook-runtime-option-${managed.runtimeId}"]`
    ) as HTMLButtonElement
    await act(async () => other.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(switchRuntime).toHaveBeenCalledWith({
      sessionId: 'session-1',
      workspaceCwd: '/tmp/proj',
      projectName: 'proj',
      language: 'python',
      runtimeId: managed.runtimeId
    })
  })

  it("shows the app's own reason when the bound runtime cannot back a kernel, and offers no dead control", async () => {
    responses = [
      {
        runtimes: [
          {
            ...managed,
            runnable: false,
            bound: true,
            detail: 'Repair the environment before running'
          }
        ],
        bindings: {
          python: { ...managed, status: 'unavailable', reason: 'repair-required' }
        }
      }
    ]

    await act(async () => {
      root.render(<NotebookPreview item={item} />)
    })
    await act(async () => {})
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    // The reason is on the row, in the app's own terms — not left for the user to discover by running a
    // cell.
    const reason = container.querySelector('[data-testid="notebook-runtime-reason"]')
    expect(reason?.textContent).toContain('repair-required')
    // And an unrunnable runtime cannot be chosen, so the click cannot be a no-op.
    const option = container.querySelector(
      `[data-testid="notebook-runtime-option-${managed.runtimeId}"]`
    ) as HTMLButtonElement
    expect(option.disabled).toBe(true)
  })
})

// IC15: the kernel's own controls. The gap this closed is that restart surfaced ONLY off the R
// install/uninstall recommendation, so a python kernel had no visible way to be restarted or closed
// from the pane. Every assertion here is about the window: that the controls are present for a plain
// python kernel, and that each click reaches the main process with THIS session's request.
describe('NotebookPreview kernel controls (IC15)', () => {
  const item: NotebookPreviewItem = {
    id: 'tool:notebook:kernel-controls',
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

  const sessionSnapshot = (): unknown => ({
    id: 'session-1',
    sessionId: 'session-1',
    cwd: '/tmp/proj',
    notebookSessionRoot: '/tmp/proj/.notebook',
    dataRoot: '/tmp/proj/.notebook/data',
    runtimeRoot: '/tmp/proj/.notebook/runtime',
    kernelStatus: 'idle',
    runJsonPath: '/tmp/proj/.notebook/run.json',
    cells: [],
    runs: [makeRun({ runId: 'p1', kernelKind: 'python' })],
    recentRuns: [],
    environments: []
  })

  let restart: ReturnType<typeof vi.fn>
  let shutdown: ReturnType<typeof vi.fn>
  let state: ReturnType<typeof vi.fn>

  const mount = async (): Promise<void> => {
    useNotebookEnvStore.setState({
      status: readyStatus,
      ui: deriveProvisionUi(readyStatus, undefined, undefined, undefined)
    })
    restart = vi.fn(async () => sessionSnapshot())
    shutdown = vi.fn(async () => ({ sessionId: 'session-1', status: 'shutdown' }))
    state = vi.fn(async () => sessionSnapshot())
    window.api = {
      notebook: {
        state,
        restart,
        shutdown,
        onChanged: () => () => {},
        onAvailable: () => () => {}
      }
    } as unknown as typeof window.api

    await act(async () => {
      root.render(<NotebookPreview item={item} />)
    })
    for (let i = 0; i < 5; i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
    }
  }

  const click = async (testId: string): Promise<void> => {
    const button = container.querySelector(`[data-testid="${testId}"]`) as HTMLButtonElement
    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }

  it('always offers restart and close for a python kernel with no R recommendation pending', async () => {
    await mount()

    // The R-only banner is exactly what used to gate the control; it must NOT be the way in here.
    expect(container.querySelector('[data-testid="r-restart-banner"]')).toBeNull()

    const restartButton = container.querySelector(
      '[data-testid="kernel-restart-button"]'
    ) as HTMLButtonElement
    const closeButton = container.querySelector(
      '[data-testid="kernel-shutdown-button"]'
    ) as HTMLButtonElement
    expect(restartButton).not.toBeNull()
    expect(closeButton).not.toBeNull()
    // Both are actionable — a control whose predicate rejects every reachable target would be a shell.
    expect(restartButton.disabled).toBe(false)
    expect(closeButton.disabled).toBe(false)
    expect(restartButton.textContent).toContain('Restart kernel')
    expect(closeButton.textContent).toContain('Close kernel')
  })

  it('closes the session kernel from the pane, reports it, and re-reads the session truth', async () => {
    await mount()
    const readsBeforeClick = state.mock.calls.length

    await click('kernel-shutdown-button')

    expect(shutdown).toHaveBeenCalledWith({
      sessionId: 'session-1',
      workspaceCwd: '/tmp/proj',
      projectName: 'proj'
    })
    // The channel answers with a receipt, not a snapshot, so the pane re-reads instead of trusting it.
    expect(state.mock.calls.length).toBeGreaterThan(readsBeforeClick)
    expect(container.querySelector('[data-testid="notebook-kernel-notice"]')?.textContent).toBe(
      'Kernel closed'
    )
  })

  it('restarts the kernel from the always-present control and reports it', async () => {
    await mount()

    await click('kernel-restart-button')

    expect(restart).toHaveBeenCalledWith({
      sessionId: 'session-1',
      workspaceCwd: '/tmp/proj',
      projectName: 'proj'
    })
    expect(container.querySelector('[data-testid="notebook-kernel-notice"]')?.textContent).toBe(
      'Kernel restarted'
    )
  })
})
