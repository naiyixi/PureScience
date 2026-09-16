import { describe, expect, it } from 'vitest'

import {
  MAX_BYTE_COMPARISON_BYTES,
  REPLAY_RECIPE_FORMAT_VERSION,
  compareReplayOutputs,
  describeReplayVerdict,
  type SealedFileDigest,
  type SealedRecipe
} from './replay-verification'

const digest = (
  path: string,
  content: string,
  overrides: Partial<SealedFileDigest> = {}
): SealedFileDigest => ({
  path,
  // A stand-in for a real hash: the comparison only ever asks whether two are equal or differ.
  sha256: `sha256:${content}`,
  sizeBytes: Buffer.byteLength(content),
  bytes: Buffer.from(content).toString('base64'),
  ...overrides
})

const recipe = (overrides: Partial<SealedRecipe> = {}): SealedRecipe => ({
  formatVersion: REPLAY_RECIPE_FORMAT_VERSION,
  appVersion: '1.61.0',
  origin: 'executed',
  inputs: [digest('data/input.csv', 'x,y\n1,2\n')],
  outputs: [digest('results/table.tsv', 'a\tb\n1\t2\n')],
  ...overrides
})

describe('replay verification', () => {
  it('reproduces only when every output is byte-identical', () => {
    const sealed = recipe()
    const report = compareReplayOutputs(sealed, {
      appVersion: '1.61.0',
      outputs: [digest('results/table.tsv', 'a\tb\n1\t2\n')]
    })

    expect(report.verdict).toBe('reproduced')
    expect(report.files).toEqual([{ path: 'results/table.tsv', status: 'match' }])
    expect(describeReplayVerdict(report)).toBe('Reproduced: all 1 output(s) matched')
  })

  // The difference has to be locatable, not just detected: "the file differs" sends the reader hunting.
  it('reports where two outputs first diverge, byte for byte', () => {
    const sealed = recipe()
    const report = compareReplayOutputs(sealed, {
      appVersion: '1.61.0',
      outputs: [digest('results/table.tsv', 'a\tb\n1\t3\n')]
    })

    expect(report.verdict).toBe('differs')
    expect(report.files[0]).toMatchObject({ status: 'differs', firstDifferingByte: 6 })
    expect(describeReplayVerdict(report)).toContain('offset 6')
  })

  it('names a missing file and an unexpected one instead of reporting a count', () => {
    const sealed = recipe({
      outputs: [digest('results/a.tsv', 'a'), digest('results/b.tsv', 'b')]
    })
    const report = compareReplayOutputs(sealed, {
      appVersion: '1.61.0',
      outputs: [digest('results/a.tsv', 'a'), digest('results/c.tsv', 'c')]
    })

    expect(report.verdict).toBe('differs')
    expect(report.files).toEqual([
      { path: 'results/a.tsv', status: 'match' },
      { path: 'results/b.tsv', status: 'missing' },
      { path: 'results/c.tsv', status: 'extra' }
    ])
  })

  // "We did not check this" must never read as "this matched".
  it('reports an uncompared file as unverifiable rather than as a match', () => {
    const sealed = recipe({
      outputs: [
        digest('results/small.tsv', 'ok'),
        digest('results/huge.bin', 'x', { sizeBytes: MAX_BYTE_COMPARISON_BYTES + 1 })
      ]
    })
    const report = compareReplayOutputs(sealed, {
      appVersion: '1.61.0',
      outputs: [
        digest('results/small.tsv', 'ok'),
        digest('results/huge.bin', 'x', { sizeBytes: MAX_BYTE_COMPARISON_BYTES + 1 })
      ]
    })

    expect(report.verdict).toBe('unverifiable')
    expect(report.files[1]).toEqual({
      path: 'results/huge.bin',
      status: 'not-comparable',
      reason: 'size-beyond-comparison-bound'
    })
    expect(describeReplayVerdict(report)).toContain('exceeds the comparison bound')
  })

  it('withholds a verdict when the replay ran under a different application version', () => {
    const report = compareReplayOutputs(recipe(), {
      appVersion: '1.62.0',
      outputs: [digest('results/table.tsv', 'a\tb\n1\t2\n')]
    })

    expect(report.verdict).toBe('unverifiable')
    expect(report.reasons[0]).toContain('captured under 1.61.0, replayed under 1.62.0')
  })

  it('treats a file with no recorded digest as uncomparable, not as equal', () => {
    const sealed = recipe({ outputs: [digest('results/table.tsv', 'x', { sha256: '' })] })
    const report = compareReplayOutputs(sealed, {
      appVersion: '1.61.0',
      outputs: [digest('results/table.tsv', 'x')]
    })

    expect(report.verdict).toBe('unverifiable')
    expect(report.files[0]).toMatchObject({ reason: 'no-digest-recorded' })
  })

  it('compares by digest when bytes were not captured, and says the offset is unknown', () => {
    const sealed = recipe({ outputs: [digest('results/table.tsv', 'one', { bytes: undefined })] })
    const report = compareReplayOutputs(sealed, {
      appVersion: '1.61.0',
      outputs: [digest('results/table.tsv', 'two', { bytes: undefined })]
    })

    expect(report.verdict).toBe('differs')
    expect(report.files[0]).toMatchObject({ status: 'differs', firstDifferingByte: -1 })
    expect(report.reasons[0]).toContain('byte offset was not captured')
  })

  // The structural rule: inference is not execution, so a model's reconstruction can never certify a
  // reproduction — even when every byte happens to line up.
  it('never certifies a reproduction from reconstructed steps', () => {
    const sealed = recipe({ origin: 'reconstructed' })
    const report = compareReplayOutputs(sealed, {
      appVersion: '1.61.0',
      outputs: [digest('results/table.tsv', 'a\tb\n1\t2\n')]
    })

    expect(report.files[0]).toEqual({ path: 'results/table.tsv', status: 'match' })
    expect(report.verdict).toBe('unverifiable')
    expect(describeReplayVerdict(report)).toContain('model reconstruction')
  })

  // Two different claims, two different words: re-reading a version's own files can never be reported
  // as a re-run that reproduced them, and a re-run cannot be reported as mere record integrity.
  it('reports record integrity with its own vocabulary', () => {
    const matching = compareReplayOutputs(
      recipe(),
      { appVersion: '1.61.0', outputs: [digest('results/table.tsv', 'a\tb\n1\t2\n')] },
      'record-integrity'
    )
    const changed = compareReplayOutputs(
      recipe(),
      { appVersion: '1.61.0', outputs: [digest('results/table.tsv', 'different')] },
      'record-integrity'
    )

    expect(matching.verdict).toBe('intact')
    expect(matching.mode).toBe('record-integrity')
    expect(describeReplayVerdict(matching)).toBe(
      'Record intact: all 1 output(s) still match the recorded digests'
    )
    expect(changed.verdict).toBe('changed')
  })

  it('keeps an empty output set unverifiable rather than vacuously reproduced', () => {
    const sealed = recipe({ outputs: [] })
    const report = compareReplayOutputs(sealed, { appVersion: '1.61.0', outputs: [] })

    expect(report.files).toEqual([])
    expect(report.verdict).toBe('reproduced')
    // Nothing to compare is not the same as everything matching; the report says how many were checked.
    expect(describeReplayVerdict(report)).toBe('Reproduced: all 0 output(s) matched')
  })
})
