import { describe, expect, it } from 'vitest'

import type { NotebookRunRecord } from './notebook'

import { buildNotebookWriteAuditRows, shortContentHash } from './notebook-write-audit-rows'

const run = (overrides: Partial<NotebookRunRecord>): NotebookRunRecord =>
  ({
    runId: 'run-1',
    cellId: 'cell-1',
    source: 'user',
    kernelKind: 'python',
    script: '',
    status: 'completed',
    startedAt: 1,
    text: { stdout: '', stderr: '', traceback: '', plain: [] },
    outputs: [],
    artifacts: [],
    workingFiles: [],
    ...overrides
  }) as NotebookRunRecord

describe('notebook write audit rows', () => {
  it('keeps the newest run first, then the newest mtime', () => {
    const rows = buildNotebookWriteAuditRows([
      run({
        runId: 'old',
        startedAt: 10,
        workingFiles: [
          { path: '/w/a.csv', relativePath: 'a.csv', kind: 'raw-data', mtimeMs: 20 },
          { path: '/w/b.csv', relativePath: 'b.csv', kind: 'raw-data', mtimeMs: 30 }
        ]
      }),
      run({
        runId: 'new',
        startedAt: 20,
        workingFiles: [{ path: '/w/c.csv', relativePath: 'c.csv', kind: 'raw-data', mtimeMs: 1 }]
      })
    ])

    expect(rows.map((row) => row.runId)).toEqual(['new', 'old', 'old'])
    expect(rows.map((row) => row.relativePath)).toEqual(['c.csv', 'b.csv', 'a.csv'])
  })

  it('leaves changeKind ABSENT on a record that did not record one, instead of saying "modified"', () => {
    const rows = buildNotebookWriteAuditRows([
      run({
        workingFiles: [{ path: '/w/legacy.csv', relativePath: 'legacy.csv', kind: 'raw-data' }]
      })
    ])

    expect(rows[0].changeKind).toBeUndefined()
    expect('changeKind' in rows[0]).toBe(false)
  })

  it('carries the recorded kind and the content identity when the record has them', () => {
    const content = {
      hashes: { before: 'a'.repeat(64), after: 'b'.repeat(64) },
      states: { before: 'recorded' as const, after: 'recorded' as const }
    }
    const rows = buildNotebookWriteAuditRows([
      run({
        workingFiles: [
          {
            path: '/w/m.csv',
            relativePath: 'm.csv',
            kind: 'processed-data',
            changeKind: 'modified',
            content
          }
        ]
      })
    ])

    expect(rows[0].changeKind).toBe('modified')
    expect(rows[0].content).toEqual(content)
  })

  it('does not invent content for a legacy row', () => {
    const rows = buildNotebookWriteAuditRows([
      run({ workingFiles: [{ path: '/w/x.csv', relativePath: 'x.csv', kind: 'other' }] })
    ])

    expect(rows[0].content).toBeUndefined()
  })

  it('shortens only real hashes, and answers undefined for anything else', () => {
    expect(shortContentHash('0123456789abcdef'.repeat(4))).toBe('01234567')
    expect(shortContentHash(undefined)).toBeUndefined()
    expect(shortContentHash('not-a-hash')).toBeUndefined()
  })
})
