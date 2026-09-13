import { describe, expect, it } from 'vitest'

import type { ReproducibilityBatchEntry } from './reproducibility-report'
import {
  formatReproducibilityScorecard,
  summarizeReproducibilityBatch,
  toReproducibilityBatchEntry
} from './reproducibility-report'

const entry = (overrides: Partial<ReproducibilityBatchEntry> = {}): ReproducibilityBatchEntry => ({
  label: 'cos.png v1',
  artifactId: 'artifact-1',
  versionId: 'version-1',
  verdict: 'reproduced',
  evidenceKind: 'app-reexecution',
  counts: { compared: 1, identical: 1, mismatched: 0, notCompared: 0 },
  requiredLabels: ['per-file-outcomes'],
  ...overrides
})

describe('summarizeReproducibilityBatch', () => {
  it('verifies a batch only when every Version was reproduced by the app', () => {
    const summary = summarizeReproducibilityBatch([entry(), entry({ label: 'groups.csv v1' })])

    expect(summary.status).toBe('verified')
    expect(summary.reproduced).toBe(2)
    expect(summary.requiredLabels).toEqual([])
  })

  it('never verifies a batch that contains a byte match instead of a reproduction', () => {
    const summary = summarizeReproducibilityBatch([
      entry(),
      entry({ verdict: 'bytes-match', evidenceKind: 'external-bytes' })
    ])

    expect(summary.status).toBe('partial')
    expect(summary.status).not.toBe('verified')
    expect(summary.requiredLabels).toContain('batch-contains-bytes-match')
    expect(summary.requiredLabels).toContain('batch-not-verified')
    expect(summary.reasons).toEqual(['cos.png v1:bytes-match'])
  })

  it('fails the batch on one unreproduced Version even when the rest reproduced', () => {
    const summary = summarizeReproducibilityBatch([
      entry(),
      entry({ verdict: 'not-reproduced', evidenceKind: 'app-reexecution' })
    ])

    expect(summary.status).toBe('failed')
    expect(summary.notReproduced).toBe(1)
  })

  it('keeps an unjudged Version from being averaged away', () => {
    const summary = summarizeReproducibilityBatch([
      entry(),
      entry({ verdict: 'inconclusive', requiredLabels: ['partial-comparison'] })
    ])

    expect(summary.status).toBe('partial')
    expect(summary.requiredLabels).toContain('batch-contains-inconclusive')
  })

  it('reports a batch in which nothing could be checked as not-checkable', () => {
    const summary = summarizeReproducibilityBatch([
      entry({ verdict: 'not-checkable', evidenceKind: 'none' }),
      entry({ verdict: 'not-checkable', evidenceKind: 'none' })
    ])

    expect(summary.status).toBe('not-checkable')
    expect(summary.requiredLabels).toContain('batch-contains-not-checkable')
  })

  it('refuses to grade an empty batch', () => {
    const summary = summarizeReproducibilityBatch([])

    expect(summary.status).toBe('not-checkable')
    expect(summary.requiredLabels).toEqual(['no-versions-checked'])
  })
})

describe('toReproducibilityBatchEntry', () => {
  it('carries the verdict, evidence and replay state from a report', () => {
    const batchEntry = toReproducibilityBatchEntry({
      label: 'cos.png v1',
      artifactId: 'artifact-1',
      versionId: 'version-1',
      report: {
        checkedAt: '2026-09-13T00:00:00.000Z',
        recipe: {
          schemaVersion: 1,
          identity: {
            artifactId: 'artifact-1',
            versionId: 'version-1',
            versionNumber: 1,
            filename: 'cos.png'
          },
          expected: { sha256: 'a'.repeat(64), sizeBytes: 8 },
          execution: null,
          environment: null,
          inputs: [],
          sealed: true,
          unsealedReasons: [],
          caveats: []
        },
        comparisons: [],
        verdict: 'bytes-match',
        evidenceKind: 'external-bytes',
        counts: { compared: 1, identical: 1, mismatched: 0, notCompared: 0 },
        reasons: ['no-re-execution-evidence'],
        requiredLabels: ['external-bytes-no-reexecution'],
        replay: {
          runnable: false,
          refusals: ['execution-evidence-missing'],
          notes: [],
          stagedInputCount: 0,
          expectedOutputCount: 0
        }
      }
    })

    expect(batchEntry).toMatchObject({
      label: 'cos.png v1',
      verdict: 'bytes-match',
      evidenceKind: 'external-bytes'
    })
    expect(batchEntry.replayState).toBeUndefined()
  })
})

describe('formatReproducibilityScorecard', () => {
  it('lists every Version with its verdict, evidence and comparison counts', () => {
    const scorecard = formatReproducibilityScorecard(
      [
        entry(),
        entry({
          label: 'groups.csv v1',
          verdict: 'not-reproduced',
          evidenceKind: 'app-reexecution',
          counts: { compared: 1, identical: 0, mismatched: 1, notCompared: 0 },
          replayState: 'completed'
        })
      ],
      { sessionId: 'session-1', generatedAt: '2026-09-13T00:00:00.000Z' }
    )

    expect(scorecard).toContain('合计：1/2 重跑复现')
    expect(scorecard).toContain('❌ 存在未复现的产物')
    expect(scorecard).toContain('| cos.png v1 | ✅ 重跑复现 |')
    expect(scorecard).toContain('| groups.csv v1 | ❌ 未复现 |')
    expect(scorecard).toContain('会话：session-1')
    expect(scorecard).toContain('只有应用自己在隔离目录内重跑过')
  })

  it('is deterministic for the same entries', () => {
    const first = formatReproducibilityScorecard([entry()])
    const second = formatReproducibilityScorecard([entry()])

    expect(second).toBe(first)
  })
})
