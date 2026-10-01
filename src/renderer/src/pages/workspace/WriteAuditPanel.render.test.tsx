// @vitest-environment jsdom
// Render + interaction tests for the WriteAuditPanel (session write audit).

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'

import type { NotebookRunRecord } from '../../../../shared/notebook'
import {
  buildFileEvidence,
  capturedReadEvidence,
  uncapturedReadEvidence
} from '../../../../shared/notebook'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { WriteAuditPanel } from './WriteAuditPanel'

const makeRun = (overrides: Partial<NotebookRunRecord>): NotebookRunRecord =>
  ({
    runId: 'run-1',
    cellId: 'cell-1',
    source: 'agent',
    inputKind: 'cell',
    kernelKind: 'python',
    script: 'print(1)',
    status: 'completed',
    startedAt: 1_700_000_000_000,
    executionCount: 1,
    environment: 'default-python',
    text: { stdout: '', stderr: '', traceback: '', plain: [] },
    outputs: [],
    artifacts: [],
    workingFiles: [],
    inputFiles: [],
    ...overrides
  }) as NotebookRunRecord

let container: HTMLElement
let root: Root

const renderPanel = (runs: NotebookRunRecord[]): void => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root.render(<WriteAuditPanel runs={runs} />)
  })
}

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('WriteAuditPanel', () => {
  it('shows the empty state when no runs have working files', () => {
    renderPanel([makeRun({})])
    expect(container.querySelector('[data-testid="write-audit-empty"]')).not.toBeNull()
    expect(container.textContent).toContain('No file writes recorded')
  })

  it('renders created/modified/removed rows with path, size, time, and run index', () => {
    renderPanel([
      makeRun({
        runId: 'run-1',
        executionCount: 1,
        startedAt: 1_000,
        workingFiles: [
          {
            path: '/data/r1.csv',
            relativePath: 'r1.csv',
            kind: 'raw-data',
            changeKind: 'created',
            size: 1024,
            mtimeMs: 500
          },
          {
            path: '/data/r1.csv',
            relativePath: 'r1.csv',
            kind: 'raw-data',
            changeKind: 'modified',
            size: 2048,
            mtimeMs: 600
          }
        ]
      }),
      makeRun({
        runId: 'run-2',
        executionCount: 2,
        startedAt: 2_000,
        workingFiles: [
          {
            path: '/data/old.txt',
            relativePath: 'old.txt',
            kind: 'other',
            changeKind: 'removed',
            size: 64,
            mtimeMs: 700
          }
        ]
      })
    ])

    const rows = container.querySelectorAll('[data-testid="write-audit-row"]')
    expect(rows).toHaveLength(3)
    expect(container.textContent).toContain('created 1')
    expect(container.textContent).toContain('modified 1')
    expect(container.textContent).toContain('removed 1')
    expect(container.textContent).toContain('r1.csv')
    expect(container.textContent).toContain('old.txt')
    expect(container.textContent).toContain('#1')
    expect(container.textContent).toContain('#2')
  })

  it('filters rows by change kind', () => {
    renderPanel([
      makeRun({
        workingFiles: [
          { path: '/data/a', relativePath: 'a', kind: 'other', changeKind: 'created', size: 1 },
          { path: '/data/b', relativePath: 'b', kind: 'other', changeKind: 'modified', size: 2 },
          { path: '/data/c', relativePath: 'c', kind: 'other', changeKind: 'removed', size: 3 }
        ]
      })
    ])

    const createdButton = container.querySelector(
      '[data-testid="write-audit-filter-created"]'
    ) as HTMLButtonElement
    act(() => createdButton.click())
    let rows = container.querySelectorAll('[data-testid="write-audit-row"]')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.textContent).toContain('a')

    const removedButton = container.querySelector(
      '[data-testid="write-audit-filter-removed"]'
    ) as HTMLButtonElement
    act(() => removedButton.click())
    rows = container.querySelectorAll('[data-testid="write-audit-row"]')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.textContent).toContain('c')
  })

  it('lists what the session read, separating an input from a file this run wrote', () => {
    renderPanel([
      makeRun({
        fileEvidence: buildFileEvidence(
          capturedReadEvidence([
            { path: '/data/raw.csv', relativePath: 'data/raw.csv', kind: 'input', reads: 2 },
            { path: '/data/clean.csv', relativePath: 'data/clean.csv', kind: 'intermediate' }
          ]),
          { status: 'captured' }
        )
      })
    ])

    const rows = container.querySelectorAll('[data-testid="write-audit-read-row"]')
    expect(rows).toHaveLength(2)
    expect(container.textContent).toContain('data/raw.csv')
    expect(container.textContent).toContain('input')
    expect(container.textContent).toContain('written by this run')
    // The read table is its own surface: no read may leak into the write table.
    expect(container.querySelectorAll('[data-testid="write-audit-row"]')).toHaveLength(0)
  })

  it('says a bounded read capture is short instead of presenting it as complete', () => {
    renderPanel([
      makeRun({
        fileEvidence: buildFileEvidence(
          { read: [], readStatus: 'truncated', readTruncatedCount: 37 },
          { status: 'captured' }
        )
      })
    ])

    expect(
      container.querySelector('[data-testid="write-audit-read-truncated"]')?.textContent
    ).toContain('37')
  })

  it('names why reads were not captured rather than showing an empty list', () => {
    renderPanel([
      makeRun({
        fileEvidence: buildFileEvidence(uncapturedReadEvidence('kernel-language-unsupported'), {
          status: 'captured'
        })
      })
    ])

    const body =
      container.querySelector('[data-testid="write-audit-read-empty"]')?.textContent ?? ''
    expect(body).toContain('were not captured')
    expect(body).toContain('no read capture')
  })

  it('says a record predates the evidence instead of claiming it read nothing', () => {
    renderPanel([makeRun({})])

    expect(
      container.querySelector('[data-testid="write-audit-read-empty"]')?.textContent
    ).toContain('no read evidence')
    expect(
      container.querySelector('[data-testid="write-audit-legacy-runs"]')?.textContent
    ).toContain('1')
  })

  it("keeps a shared directory's changes labelled as unattributed, out of the file list", () => {
    renderPanel([
      makeRun({
        fileEvidence: buildFileEvidence(capturedReadEvidence([]), {
          status: 'unattributed',
          reason: 'attribution-conflict',
          directoryConflict: 'shared-directory',
          observedPaths: ['data/a.csv']
        })
      })
    ])

    const notice =
      container.querySelector('[data-testid="write-audit-shared-directory"]')?.textContent ?? ''
    expect(notice).toContain('1')
    expect(notice).toContain('data/a.csv')
    // The observation is shown, but never as one of this run's written files.
    expect(container.querySelectorAll('[data-testid="write-audit-row"]')).toHaveLength(0)
  })

  it('reports a path that was opened but not found without calling it an input', () => {
    renderPanel([
      makeRun({
        fileEvidence: buildFileEvidence(
          capturedReadEvidence([
            { path: '/data/gone.csv', relativePath: 'data/gone.csv', kind: 'missing' }
          ]),
          { status: 'captured' }
        )
      })
    ])

    const notice = container.querySelector('[data-testid="write-audit-read-missing"]')?.textContent ?? ''
    expect(notice).toContain('data/gone.csv')
    expect(notice).toContain('not found')
    // It must not show up as a file the result read.
    expect(container.querySelectorAll('[data-testid="write-audit-read-row"]')).toHaveLength(0)
  })

  it('says a bounded write capture is short instead of presenting it as complete', () => {
    renderPanel([
      makeRun({
        fileEvidence: buildFileEvidence(capturedReadEvidence([]), {
          status: 'truncated',
          droppedCount: 12
        })
      })
    ])

    expect(
      container.querySelector('[data-testid="write-audit-write-truncated"]')?.textContent
    ).toContain('12')
  })

  it('falls back to modified for legacy rows without changeKind', () => {
    renderPanel([
      makeRun({
        workingFiles: [{ path: '/data/legacy', relativePath: 'legacy', kind: 'other', size: 5 }]
      })
    ])
    expect(container.textContent).toContain('modified')
  })
})
