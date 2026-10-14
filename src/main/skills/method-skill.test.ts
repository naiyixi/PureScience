import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import type { NotebookRunRecord } from '../../shared/notebook'
import { notebookRunSourceHash } from '../notebook/run-risk-receipt'
import {
  compileMethodSkill,
  METHOD_SKILL_FINGERPRINT_PREFIX,
  type MethodRunRecord
} from './method-skill'

const SCRIPT = [
  'import pandas as pd',
  'frame = pd.read_csv("data/input.csv")',
  'frame.dropna().to_csv("data/clean.csv", index=False)',
  'print(len(frame))'
].join('\n')

const baseRun = (overrides: Partial<MethodRunRecord> = {}): MethodRunRecord => {
  const script = overrides.script ?? SCRIPT
  const run: NotebookRunRecord = {
    runId: 'run-1',
    cellId: 'cell-1',
    source: 'agent',
    kernelKind: 'python',
    script,
    status: 'completed',
    startedAt: 1_700_000_000_000,
    executionCount: 3,
    environment: 'md-venv',
    text: { stdout: '128\n', stderr: '', traceback: '', plain: ['128'] },
    outputs: [],
    artifacts: [],
    workingFiles: [
      { path: '/root/data/clean.csv', relativePath: 'data/clean.csv', kind: 'processed-data', changeKind: 'created' }
    ],
    riskReview: {
      verdict: 'allow',
      ruleSetVersion: 'v1',
      codeHash: notebookRunSourceHash(script),
      hits: []
    }
  }
  return { ...run, ...overrides }
}

// Third-party recomputation: written from the PUBLISHED recipe text, calling nothing from the module
// under test (only node:crypto), because "the author can recompute it" proves nothing about a reader.
const recomputeFingerprint = (input: {
  run: MethodRunRecord
  sourceHash: string
  instructions: string
}): string =>
  `${METHOD_SKILL_FINGERPRINT_PREFIX}${createHash('sha256')
    .update(
      [
        'v1',
        input.run.runId,
        input.run.cellId,
        input.run.kernelKind,
        input.sourceHash,
        input.run.executionCount === undefined ? 'not-recorded' : String(input.run.executionCount),
        input.run.status,
        createHash('sha256').update(input.instructions, 'utf8').digest('hex')
      ].join(String.fromCharCode(0)),
      'utf8'
    )
    .digest('hex')}`

describe('compileMethodSkill', () => {
  it('compiles the same record to the same bytes and the same fingerprint', () => {
    const first = compileMethodSkill({ run: baseRun(), name: 'clean-a-frame' })
    const second = compileMethodSkill({ run: baseRun(), name: 'clean-a-frame' })

    expect(first.state).toBe('compiled')
    expect(second.state).toBe('compiled')
    if (first.state !== 'compiled' || second.state !== 'compiled') return
    expect(second.draft.instructions).toBe(first.draft.instructions)
    expect(second.draft.fingerprint).toBe(first.draft.fingerprint)
  })

  it('carries a fingerprint a third party recomputes from the published recipe alone', () => {
    const run = baseRun()
    const compiled = compileMethodSkill({ run, name: 'clean-a-frame' })
    expect(compiled.state).toBe('compiled')
    if (compiled.state !== 'compiled') return

    // The source hash is the receipt's own hash, not a second implementation of it.
    expect(compiled.draft.sourceHash).toBe(notebookRunSourceHash(run.script))
    expect(compiled.draft.sourceHashProvenance).toBe('receipt')
    expect(compiled.draft.fingerprint).toBe(
      recomputeFingerprint({
        run,
        sourceHash: notebookRunSourceHash(run.script),
        instructions: compiled.draft.instructions
      })
    )
    // The body never carries the fingerprint: the provenance block cites the recipe, and the fingerprint
    // lives in the document's evidence fields — citing it in the body it hashes would be a cycle.
    expect(compiled.draft.instructions).not.toContain(compiled.draft.fingerprint)
    expect(compiled.draft.evidence.join('\n')).toContain(compiled.draft.fingerprint)
    expect(compiled.draft.provenance.originRunId).toBe('run-1')
  })

  it('keeps the run identity, the source hash and the risk receipt provenance in the evidence', () => {
    const compiled = compileMethodSkill({ run: baseRun(), name: 'clean-a-frame' })
    expect(compiled.state).toBe('compiled')
    if (compiled.state !== 'compiled') return
    const evidence = compiled.draft.evidence.join('\n')
    expect(evidence).toContain('run: run-1 / cell cell-1 / python / completed')
    expect(evidence).toContain('from the run risk receipt')
    expect(evidence).toContain('method-skill:v1')

    // A record older than the receipt has no codeHash: the hash is then recomputed on read, and the
    // evidence says which of the two it is instead of letting the reader assume it was assessed.
    const legacy = compileMethodSkill({
      run: baseRun({ riskReview: undefined }),
      name: 'clean-a-frame'
    })
    expect(legacy.state).toBe('compiled')
    if (legacy.state !== 'compiled') return
    expect(legacy.draft.sourceHashProvenance).toBe('computed-on-read')
    expect(legacy.draft.evidence.join('\n')).toContain('recomputed on read')
  })

  it('names each way a record cannot become a method', () => {
    const empty = compileMethodSkill({ run: baseRun({ script: '   \n  ' }), name: 'nothing' })
    expect(empty).toMatchObject({ state: 'refused', reason: 'no-steps' })

    const running = compileMethodSkill({ run: baseRun({ status: 'running' }), name: 'too-early' })
    expect(running).toMatchObject({ state: 'refused', reason: 'unsettled-run' })

    // Edited after review: the receipt's hash and the cell text disagree, so this record is not the
    // method that was approved. Compiling it anyway would file an unreviewed procedure as reviewed.
    const edited = compileMethodSkill({
      run: baseRun({
        riskReview: { verdict: 'allow', ruleSetVersion: 'v1', codeHash: 'a'.repeat(64), hits: [] }
      }),
      name: 'edited'
    })
    expect(edited).toMatchObject({ state: 'refused', reason: 'source-changed' })

    const long = compileMethodSkill({
      run: baseRun({ script: `print("${'x'.repeat(25_000)}")` }),
      name: 'huge'
    })
    expect(long).toMatchObject({ state: 'refused', reason: 'too-long' })
  })

  it('compiles a failed run as a failure mode with its reproduction', () => {
    const compiled = compileMethodSkill({
      run: baseRun({
        status: 'failed',
        text: { stdout: '', stderr: 'error: unsupported option', traceback: 'Traceback\nValueError: boom', plain: [] }
      }),
      name: 'pip-build-vina'
    })
    expect(compiled.state).toBe('compiled')
    if (compiled.state !== 'compiled') return
    expect(compiled.draft.kind).toBe('failure-mode')
    expect(compiled.draft.provenance.kind).toBe('failure-mode')
    // A failure mode is kept for its reproduction — the record supplies it, the caller cannot.
    expect(compiled.draft.evidence.join('\n')).toContain('ValueError: boom')
    expect(compiled.draft.provenance.verification).toBe('unverified')
  })

  it('leaves absolute paths out of the body while keeping the relative ones', () => {
    const compiled = compileMethodSkill({
      run: baseRun({
        workingFiles: [
          { path: '/root/data/clean.csv', relativePath: 'data/clean.csv', kind: 'processed-data', changeKind: 'created' },
          { path: '/root/tmp/scratch.bin', relativePath: '/root/tmp/scratch.bin', kind: 'other', changeKind: 'created' }
        ]
      }),
      name: 'clean-a-frame'
    })
    expect(compiled.state).toBe('compiled')
    if (compiled.state !== 'compiled') return
    expect(compiled.draft.instructions).toContain('data/clean.csv')
    expect(compiled.draft.instructions).not.toContain('/root/tmp/scratch.bin')
    // No timestamps either: a reader comparing two compiles must be comparing the method.
    expect(compiled.draft.instructions).not.toContain('1700000000000')
  })

  it('widens the code fence when the cell itself contains backticks', () => {
    const compiled = compileMethodSkill({
      run: baseRun({ script: 'docs = """```\nfenced\n```"""\nprint(docs)' }),
      name: 'fenced-cell'
    })
    expect(compiled.state).toBe('compiled')
    if (compiled.state !== 'compiled') return
    // Three backticks would close early and print something that is not the cell.
    expect(compiled.draft.instructions).toContain('````python')
    expect(compiled.draft.instructions.match(/````/g)?.length).toBe(2)
  })

  it('derives a description when the caller gives none', () => {
    const compiled = compileMethodSkill({ run: baseRun(), name: 'clean-a-frame' })
    expect(compiled.state).toBe('compiled')
    if (compiled.state !== 'compiled') return
    expect(compiled.draft.description).toBe('Runs the recorded python cell from run run-1.')
  })
})
