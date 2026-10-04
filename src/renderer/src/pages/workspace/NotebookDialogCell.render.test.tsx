// @vitest-environment jsdom
// NotebookDialogCell is the run cell shared by the session notebook dialog and the provenance panel's
// Execution Log. Two statements it must get right, both of which it used to get wrong or omit:
//
//   * a run that stopped for a reason outside the code is not a failed run — the recorder marks an
//     app-terminated interruption as NOT failed ("the code may have been fine"), so the badge must state
//     the status the run actually has instead of folding every problem status into "error";
//   * the stored script can be a clipped version of the run's script, and this cell is what a reader copies
//     and what the .ipynb export carries — a clipped script shown unlabelled asserts a completeness the log
//     does not have.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { NotebookRunRecord } from '../../../../shared/notebook'
import { NotebookDialogCell } from './SessionNotebookDialog'

vi.mock('./notebook-code', () => ({
  NotebookCodeBlock: (props: { code: string }) => (
    <pre data-testid="notebook-code-block">{props.code}</pre>
  )
}))

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

let container: HTMLDivElement
let root: Root

const render = async (run: NotebookRunRecord, scriptTruncated = false): Promise<void> => {
  await act(async () => {
    root.render(<NotebookDialogCell run={run} index={0} scriptTruncated={scriptTruncated} />)
  })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('NotebookDialogCell statements', () => {
  it('states an app-terminated interruption instead of calling it an error', async () => {
    await render(makeRun({ status: 'interrupted', interruptionReason: 'app-terminated' }))

    const badge = container.querySelector('[data-testid="session-notebook-cell-problem"]')
    const text = (badge?.textContent ?? '').trim()
    console.log(`[dialog-cell-badge] ${text}`)
    expect(text).toContain('interrupted')
    expect(text).toContain('the app closed before it finished')
    expect(text).not.toContain('error')
  })

  it('still calls a genuine failure an error', async () => {
    await render(makeRun({ status: 'failed' }))

    const text = (
      container.querySelector('[data-testid="session-notebook-cell-problem"]')?.textContent ?? ''
    ).trim()
    expect(text).toBe('error')
  })

  it('says a stored script was shortened, and stays quiet when it was not', async () => {
    await render(makeRun(), true)
    const notice = container.querySelector('[data-testid="session-notebook-cell-script-truncated"]')
    console.log(`[dialog-cell-script] ${notice?.textContent}`)
    expect(notice).not.toBeNull()
    expect(notice?.textContent ?? '').toContain('shortened before it was stored')

    await render(makeRun(), false)
    expect(
      container.querySelector('[data-testid="session-notebook-cell-script-truncated"]')
    ).toBeNull()
  })
})
