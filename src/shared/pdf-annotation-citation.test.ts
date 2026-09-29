import { describe, expect, it } from 'vitest'

import {
  PDF_ANNOTATION_CITATION_SCHEMA_VERSION,
  alignPdfAnnotationCitationsWithScreeningExport,
  buildPdfAnnotationCitation,
  formatAnnotationCitationAlignment,
  formatPdfAnnotationCitation,
  pdfAnnotationLocator,
  pdfAnnotationQuote,
  type AnnotationCitationReference,
  type PdfAnnotationCitationInput,
  type PdfAnnotationCitationLabels,
  type PdfAnnotationCitationRecord
} from './pdf-annotation-citation'
import {
  SCREENING_NAMED_REASONS,
  SCREENING_VERDICTS,
  type ScreeningNamedReason,
  type ScreeningVerdict
} from './references-screening'
import type { ScreeningExportScope } from './references-screening-export'

// A PDF annotation as a citation (A5, 需求 2). The suite is about the four facts a reader needs to check
// the citation for themselves — which bytes, which page, which box, which passage — and about the export
// range being ONE range: the annotation chain reads the same `ScreeningExportScope` the triage export
// reads, so "the bibliography contains only included records" and "each entry shows its evidence" are two
// readings of one decision rather than two filters that could drift apart.

const citationInput = (
  overrides: Partial<PdfAnnotationCitationInput> = {}
): PdfAnnotationCitationInput => ({
  annotationId: 'annotation-1',
  sourceFileId: 'artifact-1',
  versionId: 'version-1',
  checksum: 'a'.repeat(64),
  kind: 'highlight',
  selector: {
    version: 1,
    shape: 'text-range',
    page: 4,
    rects: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.04 }],
    quote: 'the effect is large'
  },
  body: 'Check this against Table 2.',
  createdAt: 1_700_000_000_000,
  anchorState: 'current',
  ...overrides
})

const recordOf = (
  overrides: Partial<PdfAnnotationCitationInput> = {}
): PdfAnnotationCitationRecord => {
  const outcome = buildPdfAnnotationCitation(citationInput(overrides))
  if (outcome.status !== 'record') throw new Error(outcome.message)
  return outcome.record
}

const labels: PdfAnnotationCitationLabels = {
  header: 'Annotation',
  file: 'File',
  version: 'Version',
  checksum: 'Checksum',
  page: 'Page',
  region: 'Region',
  quote: 'Quote',
  note: 'Note',
  anchorState: 'Anchor'
}

const scope = (includedReferenceIds: string[]): ScreeningExportScope => ({
  kind: 'included-only',
  collectionId: 'collection-1',
  includedReferenceIds,
  includedCount: includedReferenceIds.length,
  totalCount: includedReferenceIds.length,
  notExportedCount: 0,
  notExportedCounts: Object.fromEntries(
    SCREENING_VERDICTS.map((verdict) => [verdict, 0])
  ) as Record<ScreeningVerdict, number>,
  notExportedByReason: Object.fromEntries(
    SCREENING_NAMED_REASONS.map((reason) => [reason, 0])
  ) as Record<ScreeningNamedReason, number>,
  includedByOverrideCount: 0,
  notExportedByOverrideCount: 0,
  ruleRevision: 3,
  ruleContentHash: 'b'.repeat(64)
})

const reference = (
  overrides: Partial<AnnotationCitationReference> = {}
): AnnotationCitationReference => ({
  id: 'ref-1',
  title: 'A randomized trial of something',
  authors: [{ name: 'Ada Lovelace' }, { name: 'Alan Turing' }],
  venue: 'Journal of Tests',
  year: 2024,
  doi: '10.1000/xyz',
  ...overrides
})

describe('pdfAnnotationLocator / pdfAnnotationQuote', () => {
  it('reads the page and the boxes from each selector shape, without inventing either', () => {
    expect(
      pdfAnnotationLocator({
        version: 1,
        shape: 'text-range',
        page: 2,
        rects: [{ x: 0, y: 0, width: 1, height: 0.1 }],
        quote: 'q'
      })
    ).toEqual({ page: 2, rects: [{ x: 0, y: 0, width: 1, height: 0.1 }] })
    expect(
      pdfAnnotationLocator({
        version: 1,
        shape: 'area',
        page: 5,
        rect: { x: 0, y: 0, width: 0.5, height: 0.5 }
      })
    ).toEqual({ page: 5, rects: [{ x: 0, y: 0, width: 0.5, height: 0.5 }] })
    // A page note placed nowhere on the page: the page is known, the box is not, and no box is invented.
    expect(pdfAnnotationLocator({ version: 1, shape: 'page-note', page: 6 })).toEqual({
      page: 6,
      rects: []
    })
    // A document-wide note has neither, and says so.
    expect(pdfAnnotationLocator({ version: 1, shape: 'document-note' })).toEqual({ rects: [] })

    expect(
      pdfAnnotationQuote({
        version: 1,
        shape: 'text-range',
        page: 1,
        rects: [{ x: 0, y: 0, width: 1, height: 0.1 }],
        quote: 'quoted'
      })
    ).toBe('quoted')
    expect(
      pdfAnnotationQuote({
        version: 1,
        shape: 'area',
        page: 1,
        rect: { x: 0, y: 0, width: 1, height: 0.1 }
      })
    ).toBe('')
  })
})

describe('buildPdfAnnotationCitation', () => {
  it('carries the version anchor, the page, the boxes and the quoted passage', () => {
    const record = recordOf()

    expect(record).toEqual({
      schemaVersion: PDF_ANNOTATION_CITATION_SCHEMA_VERSION,
      annotationId: 'annotation-1',
      kind: 'highlight',
      anchor: { sourceFileId: 'artifact-1', versionId: 'version-1', checksum: 'a'.repeat(64) },
      anchorState: 'current',
      page: 4,
      rects: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.04 }],
      quote: 'the effect is large',
      body: 'Check this against Table 2.',
      createdAt: 1_700_000_000_000
    })
  })

  it('refuses a stored row whose kind and selector disagree, by name', () => {
    const outcome = buildPdfAnnotationCitation(
      citationInput({
        kind: 'highlight',
        selector: { version: 1, shape: 'area', page: 1, rect: { x: 0, y: 0, width: 1, height: 1 } }
      })
    )

    expect(outcome.status).toBe('refused')
    if (outcome.status !== 'refused') throw new Error('expected a refusal')
    expect(outcome.code).toBe('selector-shape-mismatch')
    expect(outcome.annotationId).toBe('annotation-1')
    expect(outcome.message).toContain('highlight')
  })

  it('refuses a selector written by a newer build rather than guessing at its fields', () => {
    const outcome = buildPdfAnnotationCitation(
      citationInput({
        selector: {
          version: 99,
          shape: 'text-range',
          page: 1,
          rects: [{ x: 0, y: 0, width: 1, height: 1 }],
          quote: 'q'
        }
      })
    )

    expect(outcome).toMatchObject({ status: 'refused', code: 'unsupported-selector-version' })
  })

  it('keeps the anchor state it was given instead of claiming the markup is current', () => {
    expect(recordOf({ anchorState: 'version-changed' }).anchorState).toBe('version-changed')
    expect(recordOf({ anchorState: 'checksum-mismatch' }).anchorState).toBe('checksum-mismatch')
  })

  it('bounds the two texts, because a citation points at a passage rather than pasting a page', () => {
    const record = recordOf({ body: 'x'.repeat(20_000) })

    expect(record.body.length).toBe(8_000)
  })
})

describe('formatPdfAnnotationCitation', () => {
  it('prints the anchor, the page, every box and the quoted passage', () => {
    const text = formatPdfAnnotationCitation(recordOf(), labels)

    expect(text.split('\n')).toEqual([
      'Annotation: annotation-1 (highlight)',
      'File: artifact-1',
      'Version: version-1',
      `Checksum: sha256:${'a'.repeat(64)}`,
      'Anchor: current',
      'Page: 4',
      'Region 1: 0.100 0.200 0.300 0.040',
      'Quote: the effect is large',
      'Note: Check this against Table 2.'
    ])
  })

  it('omits the page and the box for a document-wide note rather than printing a placeholder', () => {
    const text = formatPdfAnnotationCitation(
      recordOf({
        kind: 'document-note',
        selector: { version: 1, shape: 'document-note' },
        body: 'Whole document.'
      }),
      labels
    )

    expect(text).not.toContain('Page:')
    expect(text).not.toContain('Region 1:')
    expect(text).toContain('Note: Whole document.')
  })
})

describe('alignPdfAnnotationCitationsWithScreeningExport', () => {
  it('reads the range the triage export reads, in the range’s own order', () => {
    const alignment = alignPdfAnnotationCitationsWithScreeningExport({
      exportScope: scope(['ref-2', 'ref-1']),
      references: [reference({ id: 'ref-1' }), reference({ id: 'ref-2', title: 'Second paper' })],
      citations: [
        { referenceId: 'ref-1', outcome: { status: 'record', record: recordOf() } },
        {
          referenceId: 'ref-2',
          outcome: { status: 'record', record: recordOf({ annotationId: 'annotation-2' }) }
        }
      ]
    })

    expect(alignment.entries.map((entry) => entry.referenceId)).toEqual(['ref-2', 'ref-1'])
    expect(alignment.entries[0]!.citation).toContain('Second paper')
    expect(alignment.entries[0]!.citation).toContain('2024')
    expect(alignment.entries[1]!.annotations.map((record) => record.annotationId)).toEqual([
      'annotation-1'
    ])
    expect(alignment.counts).toEqual({
      exportableReferences: 2,
      referencesWithEvidence: 2,
      alignedAnnotations: 2,
      notAlignedAnnotations: 0
    })
    expect(alignment.scope).toEqual({
      kind: 'included-only',
      collectionId: 'collection-1',
      ruleRevision: 3
    })
  })

  it('keeps an excluded record’s markup out and names the reason', () => {
    const alignment = alignPdfAnnotationCitationsWithScreeningExport({
      exportScope: scope(['ref-1']),
      references: [reference({ id: 'ref-1' }), reference({ id: 'ref-2' })],
      citations: [{ referenceId: 'ref-2', outcome: { status: 'record', record: recordOf() } }]
    })

    expect(alignment.entries).toEqual([])
    expect(alignment.counts.referencesWithEvidence).toBe(0)
    expect(alignment.notAligned).toEqual([
      { annotationId: 'annotation-1', reason: 'reference-not-in-export-range' }
    ])
  })

  it('reports markup on other bytes as not-current rather than citing it as if it were', () => {
    const alignment = alignPdfAnnotationCitationsWithScreeningExport({
      exportScope: scope(['ref-1']),
      references: [reference()],
      citations: [
        {
          referenceId: 'ref-1',
          outcome: { status: 'record', record: recordOf({ anchorState: 'version-changed' }) }
        }
      ]
    })

    expect(alignment.entries).toEqual([])
    expect(alignment.notAligned).toEqual([
      { annotationId: 'annotation-1', reason: 'anchor-not-current' }
    ])
  })

  it('reports a file that belongs to no record, and a stored row that could not be cited', () => {
    const alignment = alignPdfAnnotationCitationsWithScreeningExport({
      exportScope: scope(['ref-1']),
      references: [reference()],
      citations: [
        {
          referenceId: null,
          outcome: { status: 'record', record: recordOf({ annotationId: 'loose' }) }
        },
        {
          referenceId: 'ref-1',
          outcome: {
            status: 'refused',
            annotationId: 'broken',
            code: 'selector-shape-mismatch',
            message: 'm'
          }
        }
      ]
    })

    expect(alignment.notAligned).toEqual([
      { annotationId: 'loose', reason: 'reference-unknown' },
      { annotationId: 'broken', reason: 'annotation-refused' }
    ])
    expect(alignment.counts.notAlignedAnnotations).toBe(2)
  })

  it('leaves out an exportable record with no evidence instead of citing an empty entry', () => {
    const alignment = alignPdfAnnotationCitationsWithScreeningExport({
      exportScope: scope(['ref-1', 'ref-2']),
      references: [reference({ id: 'ref-1' }), reference({ id: 'ref-2' })],
      citations: [{ referenceId: 'ref-1', outcome: { status: 'record', record: recordOf() } }]
    })

    expect(alignment.entries.map((entry) => entry.referenceId)).toEqual(['ref-1'])
    expect(alignment.counts.exportableReferences).toBe(2)
    expect(alignment.counts.referencesWithEvidence).toBe(1)
  })

  it('orders one record’s annotations oldest first, whatever order they arrived in', () => {
    const alignment = alignPdfAnnotationCitationsWithScreeningExport({
      exportScope: scope(['ref-1']),
      references: [reference()],
      citations: [
        {
          referenceId: 'ref-1',
          outcome: { status: 'record', record: recordOf({ annotationId: 'later', createdAt: 20 }) }
        },
        {
          referenceId: 'ref-1',
          outcome: {
            status: 'record',
            record: recordOf({ annotationId: 'earlier', createdAt: 10 })
          }
        }
      ]
    })

    expect(alignment.entries[0]!.annotations.map((record) => record.annotationId)).toEqual([
      'earlier',
      'later'
    ])
  })
})

describe('formatAnnotationCitationAlignment', () => {
  it('prints each GB/T 7714 line with the annotations that are its evidence', () => {
    const alignment = alignPdfAnnotationCitationsWithScreeningExport({
      exportScope: scope(['ref-1', 'ref-2']),
      references: [reference({ id: 'ref-1' }), reference({ id: 'ref-2' })],
      citations: [
        { referenceId: 'ref-1', outcome: { status: 'record', record: recordOf() } },
        {
          referenceId: 'ref-2',
          outcome: {
            status: 'refused',
            annotationId: 'broken',
            code: 'missing-selector',
            message: 'm'
          }
        }
      ]
    })

    const text = formatAnnotationCitationAlignment(alignment, {
      header: 'Evidence',
      scope: 'range',
      evidenceCount: 'Annotations',
      annotationHeader: 'Evidence annotation',
      citationLabels: labels,
      notAligned: 'Left out',
      reasonLabels: {
        'reference-not-in-export-range': 'The range excludes its record',
        'reference-unknown': 'Its file belongs to no record',
        'anchor-not-current': 'It is on another file version',
        'annotation-refused': 'The stored row could not be cited'
      }
    })

    expect(text).toContain('Evidence: collection-1 (included-only, range r3)')
    expect(text).toContain('Annotations: 1')
    // The GB/T 7714 line for the record, followed by the annotation that is its evidence.
    expect(text).toContain(
      'Lovelace A., Turing A. A randomized trial of something[J]. Journal of Tests, 2024.'
    )
    expect(text).toContain('Evidence annotation: annotation-1 (highlight)')
    expect(text).toContain(`Checksum: sha256:${'a'.repeat(64)}`)
    expect(text).toContain('Left out: 1')
    expect(text).toContain('  broken: The stored row could not be cited')
  })
})
