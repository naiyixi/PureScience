import { describe, expect, it } from 'vitest'

import type { NotebookRunRecord } from './notebook'
import { buildFileEvidence, capturedReadEvidence, uncapturedReadEvidence } from './notebook'
import { axisVerdict, summarizeFileEvidence } from './notebook-file-evidence-summary'

const run = (
  runId: string,
  fileEvidence: NotebookRunRecord['fileEvidence'] | undefined,
  startedAt = 100
): NotebookRunRecord =>
  ({
    runId,
    cellId: `cell-${runId}`,
    source: 'agent',
    inputKind: 'cell',
    kernelKind: 'python',
    script: '',
    status: 'completed',
    startedAt,
    text: { stdout: '', stderr: '', traceback: '', plain: [] },
    outputs: [],
    artifacts: [],
    workingFiles: [],
    ...(fileEvidence ? { fileEvidence } : {})
  }) satisfies NotebookRunRecord

describe('file evidence session summary', () => {
  it('collects what the session read, newest run first', () => {
    const summary = summarizeFileEvidence([
      run(
        'older',
        buildFileEvidence(
          capturedReadEvidence([
            { path: '/s/data/raw.csv', relativePath: 'data/raw.csv', kind: 'input', reads: 2 }
          ]),
          { status: 'captured' }
        ),
        100
      ),
      run(
        'newer',
        buildFileEvidence(
          capturedReadEvidence([
            { path: '/s/data/clean.csv', relativePath: 'data/clean.csv', kind: 'intermediate' }
          ]),
          { status: 'captured' }
        ),
        200
      )
    ])

    expect(summary.readRows.map((row) => row.relativePath)).toEqual([
      'data/clean.csv',
      'data/raw.csv'
    ])
    expect(summary.readRows[1]).toMatchObject({ kind: 'input', reads: 2, runId: 'older' })
    expect(axisVerdict(summary.read)).toEqual({ kind: 'complete' })
    expect(axisVerdict(summary.write)).toEqual({ kind: 'complete' })
  })

  it('keeps the shortfall of a bounded capture visible', () => {
    const summary = summarizeFileEvidence([
      run(
        'r',
        buildFileEvidence(
          { read: [], readStatus: 'truncated', readTruncatedCount: 42 },
          { status: 'truncated', droppedCount: 7 }
        )
      )
    ])

    expect(summary.read.dropped).toBe(42)
    expect(summary.write.dropped).toBe(7)
    expect(axisVerdict(summary.read)).toEqual({ kind: 'partial', dropped: 42 })
    expect(axisVerdict(summary.write)).toEqual({ kind: 'partial', dropped: 7 })
  })

  it('counts runs written before the evidence existed instead of calling them empty', () => {
    const summary = summarizeFileEvidence([run('legacy', undefined)])

    expect(summary.runsWithoutEvidence).toBe(1)
    expect(summary.runsWithEvidence).toBe(0)
    // Both axes have nothing to say — which the interface must render as "unknown", never as "none".
    expect(axisVerdict(summary.read)).toEqual({ kind: 'none' })
    expect(axisVerdict(summary.write)).toEqual({ kind: 'none' })
  })

  it('states a partly-captured session as mixed rather than as either extreme', () => {
    const summary = summarizeFileEvidence([
      run('captured', buildFileEvidence(capturedReadEvidence([]), { status: 'captured' })),
      run(
        'r-driver',
        buildFileEvidence(uncapturedReadEvidence('driver-without-read-capture'), {
          status: 'unavailable',
          reason: 'observation-unavailable'
        })
      )
    ])

    expect(axisVerdict(summary.read)).toEqual({
      kind: 'mixed',
      captured: 1,
      missing: 1
    })
    expect(axisVerdict(summary.write)).toEqual({
      kind: 'mixed',
      captured: 1,
      missing: 1
    })
  })

  it('names why nothing was captured when no run in the session could capture', () => {
    const summary = summarizeFileEvidence([
      run(
        'r-1',
        buildFileEvidence(uncapturedReadEvidence('kernel-language-unsupported'), {
          status: 'unavailable',
          reason: 'observation-unavailable'
        })
      ),
      run(
        'r-2',
        buildFileEvidence(uncapturedReadEvidence('driver-without-read-capture'), {
          status: 'unavailable',
          reason: 'observation-unavailable'
        })
      )
    ])

    // The read axis was never capturable (unsupported), while the write axis was expected to work and
    // failed (unavailable): two different promises, and the wording has to differ.
    expect(axisVerdict(summary.read)).toEqual({
      kind: 'missing',
      status: 'unsupported',
      reasons: ['kernel-language-unsupported', 'driver-without-read-capture']
    })
    expect(axisVerdict(summary.write)).toEqual({
      kind: 'missing',
      status: 'unavailable',
      reasons: ['observation-unavailable']
    })
  })

  it('separates a path that was opened but not found from the inputs the run read', () => {
    const summary = summarizeFileEvidence([
      run(
        'r',
        buildFileEvidence(
          capturedReadEvidence([
            { path: '/s/data/real.csv', relativePath: 'data/real.csv', kind: 'input', reads: 1 },
            { path: '/s/data/gone.csv', relativePath: 'data/gone.csv', kind: 'missing' }
          ]),
          { status: 'captured' }
        )
      )
    ])

    expect(summary.readRows.map((row) => row.relativePath)).toEqual(['data/real.csv'])
    expect(summary.missingReadPaths).toEqual(['data/gone.csv'])
    expect(summary.read.captured).toBe(1)
  })

  it("keeps a shared directory's changes out of the file list but visible as an observation", () => {
    const summary = summarizeFileEvidence([
      run(
        'shared',
        buildFileEvidence(capturedReadEvidence([]), {
          status: 'unattributed',
          reason: 'attribution-conflict',
          directoryConflict: 'shared-directory',
          observedPaths: ['data/a.csv', 'data/b.csv']
        })
      ),
      run(
        'shared-2',
        buildFileEvidence(capturedReadEvidence([]), {
          status: 'unattributed',
          reason: 'attribution-conflict',
          directoryConflict: 'shared-directory',
          observedPaths: ['data/b.csv', 'data/c.csv']
        })
      )
    ])

    // Deduplicated across runs: the observer's observation, never a per-run file list.
    expect(summary.observedPaths).toEqual(['data/a.csv', 'data/b.csv', 'data/c.csv'])
    expect(summary.write.unattributed).toBe(2)
    expect(axisVerdict(summary.write)).toEqual({
      kind: 'missing',
      status: 'unattributed',
      reasons: ['attribution-conflict']
    })
  })
})
