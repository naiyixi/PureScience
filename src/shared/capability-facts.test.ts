import { describe, expect, it } from 'vitest'

import { deriveFacts } from './capability-facts'

describe('deriveFacts', () => {
  it('maps unambiguous extensions to input facts and names the file as evidence', () => {
    const { facts, sources } = deriveFacts({ fileNames: ['data/pbmc.h5ad', 'meta.csv'] })
    expect(facts).toEqual(['input:omics_file', 'input:table'])
    expect(sources['input:omics_file']).toEqual(['file:data/pbmc.h5ad'])
    expect(sources['input:table']).toEqual(['file:meta.csv'])
  })

  it('derives nothing from an ambiguous or unknown file rather than guessing', () => {
    expect(deriveFacts({ fileNames: ['seq.fasta', 'figure.png', 'notes.pdf'] })).toEqual({
      facts: [],
      sources: {}
    })
  })

  it('collects every file that established one fact, without duplicates', () => {
    const { sources } = deriveFacts({
      fileNames: ['a.h5ad', 'a.h5ad', 'b.vcf.gz']
    })
    expect(sources['input:omics_file']).toEqual(['file:a.h5ad', 'file:b.vcf.gz'])
  })

  it('turns a completed capability into the facts it declared producing', () => {
    const { facts, sources } = deriveFacts({
      completed: [
        { id: 'literature-review', produces: ['evidence:literature_set'] },
        { id: 'evidence-grading', produces: ['review:evidence_grade', 'claim:calibrated'] }
      ]
    })
    expect(facts).toEqual(['evidence:literature_set', 'review:evidence_grade', 'claim:calibrated'])
    expect(sources['evidence:literature_set']).toEqual(['capability:literature-review'])
  })

  it('keeps file evidence and capability evidence on the same fact', () => {
    const { sources } = deriveFacts({
      fileNames: ['matrix.h5ad'],
      completed: [{ id: 'preview', produces: ['input:omics_file'] }]
    })
    expect(sources['input:omics_file']).toEqual(['file:matrix.h5ad', 'capability:preview'])
  })

  it('is empty for empty input, and stable across calls', () => {
    expect(deriveFacts({})).toEqual({ facts: [], sources: {} })
    const input = { fileNames: ['x.csv'] } as const
    expect(deriveFacts(input)).toEqual(deriveFacts(input))
  })
})
