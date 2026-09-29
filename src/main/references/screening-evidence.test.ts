import { describe, expect, it } from 'vitest'

import type { Reference } from '../../shared/references'
import {
  assembleScreeningEvidence,
  resolveEvidenceCoverage,
  stripCitedWorks
} from './screening-evidence'

// Evidence assembly decides how much of a record the engine actually has, and coverage is what the
// decision-time guard (applyEvidenceCoverage) then reads. Two things must hold: the tier is derived
// from the material rather than claimed, and the content of works the paper cites never reaches the
// model as if it were this paper's own evidence (prompt guardrail ④, enforced mechanically here).

const reference = (overrides: Partial<Reference> = {}): Reference => ({
  id: 'ref-1',
  projectId: 'project-1',
  title: 'A randomized trial of something',
  authors: [{ name: 'Ada Lovelace' }, { name: 'Alan Turing' }],
  venue: 'Journal of Tests',
  year: 2024,
  doi: '10.1000/xyz',
  pmid: undefined,
  pmcid: undefined,
  arxivId: undefined,
  url: undefined,
  abstractSnippet: undefined,
  sourceConnector: 'manual',
  sourceRecordId: undefined,
  citationKey: 'Lovelace2024',
  provenance: undefined,
  pdfManagedFileId: undefined,
  notes: undefined,
  createdAt: 1,
  updatedAt: 1,
  ...overrides
})

describe('resolveEvidenceCoverage', () => {
  it.each([
    [{ hasFullText: true, hasAbstract: true, hasMetadata: true }, 'full-text'],
    [{ hasFullText: true, hasAbstract: false, hasMetadata: true }, 'full-text'],
    [{ hasFullText: false, hasAbstract: true, hasMetadata: true }, 'abstract-only'],
    [{ hasFullText: false, hasAbstract: false, hasMetadata: true }, 'metadata-only'],
    [{ hasFullText: false, hasAbstract: false, hasMetadata: false }, 'unavailable']
  ] as const)('%o resolves to %s', (tiers, expected) => {
    expect(resolveEvidenceCoverage(tiers)).toBe(expected)
  })
})

describe('assembleScreeningEvidence', () => {
  it('reads as full-text when an attachment yielded body text', () => {
    const bundle = assembleScreeningEvidence({
      reference: reference({ abstractSnippet: 'Short abstract.' }),
      fullText: 'Methods. We enrolled 120 adults aged 18-65.'
    })
    expect(bundle.coverage).toBe('full-text')
    expect(bundle.sections.fullText).toBe('Methods. We enrolled 120 adults aged 18-65.')
    expect(bundle.sections.abstract).toBe('Short abstract.')
    expect(bundle.inputChars).toBe(
      bundle.sections.fullText.length +
        bundle.sections.abstract.length +
        bundle.sections.metadata.length
    )
  })

  it('falls back to abstract-only when no readable full text exists', () => {
    const bundle = assembleScreeningEvidence({
      reference: reference({ abstractSnippet: 'We enrolled 120 adults.' }),
      fullText: null
    })
    expect(bundle.coverage).toBe('abstract-only')
    expect(bundle.sections.fullText).toBe('')
  })

  it('falls back to metadata-only when neither full text nor abstract exists', () => {
    const bundle = assembleScreeningEvidence({ reference: reference(), fullText: '   \n  ' })
    expect(bundle.coverage).toBe('metadata-only')
    expect(bundle.sections.metadata).toContain('Title: A randomized trial of something')
    expect(bundle.sections.metadata).toContain('DOI: 10.1000/xyz')
  })

  it('reads as unavailable when the record itself is gone', () => {
    const bundle = assembleScreeningEvidence({ reference: null, fullText: 'orphaned text' })
    expect(bundle.coverage).toBe('unavailable')
    expect(bundle.sections.metadata).toBe('')
  })

  it('reads as unavailable when the record carries no field at all', () => {
    const bundle = assembleScreeningEvidence({
      reference: reference({
        title: '   ',
        authors: [],
        venue: undefined,
        year: undefined,
        doi: undefined,
        citationKey: ''
      })
    })
    expect(bundle.coverage).toBe('unavailable')
  })

  it('never reports full-text for whitespace-only body text', () => {
    const bundle = assembleScreeningEvidence({
      reference: reference({ abstractSnippet: 'Has an abstract.' }),
      fullText: '\n\n   \t'
    })
    expect(bundle.coverage).toBe('abstract-only')
  })
})

describe('stripCitedWorks (prompt guardrail ④)', () => {
  it("cuts a trailing bibliography, so a cited study never becomes this record's evidence", () => {
    const text = [
      'Results. The intervention reduced blood pressure by 12 mmHg.',
      'References',
      'Smith et al. 2019. Blood pressure is unaffected by the intervention. Journal of Nope.'
    ].join('\n')
    const stripped = stripCitedWorks(text)
    expect(stripped.citedWorksRemoved).toBe(true)
    expect(stripped.body).toBe('Results. The intervention reduced blood pressure by 12 mmHg.')
    expect(stripped.body).not.toContain('Smith et al. 2019')
  })

  it('recognises the CJK heading a Chinese-language library stores', () => {
    const stripped = stripCitedWorks('方法。纳入 120 名成人。\n参考文献\n[1] 王某. 某研究. 某期刊.')
    expect(stripped.citedWorksRemoved).toBe(true)
    expect(stripped.body).toBe('方法。纳入 120 名成人。')
  })

  it('recognises numbered and alternate English headings', () => {
    expect(stripCitedWorks('Body text here.\n7. References\n[1] Cited.').body).toBe(
      'Body text here.'
    )
    expect(stripCitedWorks('Body text here.\nWorks Cited\n[1] Cited.').body).toBe('Body text here.')
  })

  it('leaves a document with no bibliography untouched', () => {
    const text = 'Introduction. We studied 120 adults.\nDiscussion. The result held.'
    expect(stripCitedWorks(text)).toEqual({ body: text, citedWorksRemoved: false })
  })

  it('does not discard a document whose first line happens to be the heading', () => {
    const text = 'References\nA heading with no body before it is not a bibliography tail.'
    expect(stripCitedWorks(text)).toEqual({ body: text, citedWorksRemoved: false })
  })

  it('flags the cut on the bundle so the omission is visible, not silent', () => {
    const bundle = assembleScreeningEvidence({
      reference: reference(),
      fullText: 'Body. The trial worked.\nReferences\n[1] Someone else. A different finding.'
    })
    expect(bundle.citedWorksRemoved).toBe(true)
    expect(bundle.sections.fullText).not.toContain('A different finding')
  })
})
