import { describe, expect, it } from 'vitest'

import { en } from '../renderer/src/i18n/en'

import {
  OMICS_PREVIEW_SCHEMA_VERSION,
  canAnswerFromPreview,
  describeFullRunHandoff,
  describeOmicsScope,
  detectOmicsFormat,
  isOmicsPreviewManifest,
  isProvisionalScope,
  summarizeOmicsPreview,
  type OmicsPreviewManifest
} from './omics-preview'

// Same shape the panel passes in: the dictionary owns the words, shared code owns the key.
const t = (key: string): string => (en as Record<string, string>)[key] ?? key

const manifest = (overrides: Partial<OmicsPreviewManifest> = {}): OmicsPreviewManifest => ({
  schemaVersion: OMICS_PREVIEW_SCHEMA_VERSION,
  path: 'data/pbmc.h5ad',
  format: 'h5ad',
  generatedAt: '2026-09-11T00:00:00.000Z',
  nObs: 20000,
  nVars: 3000,
  subset: { applied: true, requestedCells: 2000, sampledCells: 2000, sampling: 'head' },
  fullRunRequired: true,
  notes: [],
  ...overrides
})

describe('omics preview contract', () => {
  it('detects formats from the extension', () => {
    expect(detectOmicsFormat('a/b/pbmc.h5ad')).toBe('h5ad')
    expect(detectOmicsFormat('cohort.vcf')).toBe('vcf')
    expect(detectOmicsFormat('cohort.vcf.gz')).toBe('vcf-gz')
    expect(detectOmicsFormat('cohort.vcf.bgz')).toBe('vcf-gz')
    expect(detectOmicsFormat('notes.txt')).toBe('unknown')
  })

  it('labels a downsampled read with the subset fraction it actually used (G6)', () => {
    expect(describeOmicsScope(manifest(), t)).toBe('Downsampled 2000/20000 (head slice)')
    expect(
      describeOmicsScope(
        manifest({
          subset: { applied: true, requestedCells: 2000, sampledCells: 1500, sampling: 'random' }
        }),
        t
      )
    ).toBe('Downsampled 1500/20000 (random sample)')
    expect(describeOmicsScope(manifest({ subset: undefined, fullRunRequired: false }), t)).toBe(
      'Full data (20000)'
    )
  })

  it('stays honest when the total count is unknown', () => {
    const streaming = manifest({
      nObs: undefined,
      nVars: undefined,
      format: 'vcf-gz',
      variantCount: undefined
    })
    expect(describeOmicsScope(streaming, t)).toBe('Downsampled 2000/all (head slice)')
  })

  it('treats subsets and full-run requirements as provisional scopes', () => {
    expect(isProvisionalScope(manifest())).toBe(true)
    expect(isProvisionalScope(manifest({ subset: undefined, fullRunRequired: false }))).toBe(false)
    expect(
      isProvisionalScope(
        manifest({
          subset: { applied: false, requestedCells: 2000, sampledCells: 20000, sampling: 'head' },
          fullRunRequired: true
        })
      )
    ).toBe(true)
  })

  it('summarizes scope, shape and the full-run caveat for display', () => {
    const summary = summarizeOmicsPreview(manifest(), t)
    expect(summary).toContain('Downsampled 2000/20000')
    expect(summary).toContain('20000 cells × 3000 features')
    expect(summary).toContain('Full run required')
    expect(
      summarizeOmicsPreview(manifest({ format: 'unknown', nObs: undefined, nVars: undefined }), t)
    ).toContain('Format not recognised')
  })

  it('validates the hand-off shape from the python skill', () => {
    expect(isOmicsPreviewManifest(manifest())).toBe(true)
    expect(isOmicsPreviewManifest({ ...manifest(), schemaVersion: 0 })).toBe(false)
    expect(isOmicsPreviewManifest({ ...manifest(), notes: undefined })).toBe(false)
    expect(isOmicsPreviewManifest(null)).toBe(false)
  })

  it('refuses to let a preview answer the question when the scope is provisional (G1)', () => {
    expect(canAnswerFromPreview(manifest())).toBe(false)
    expect(canAnswerFromPreview(manifest({ subset: undefined, fullRunRequired: false }))).toBe(true)

    const handoff = describeFullRunHandoff(manifest())
    expect(handoff).toContain('do not deliver as a final conclusion')
    expect(handoff).toContain('wait for approval')
    expect(handoff).toContain('not computed')
    expect(handoff).toContain('provenance')
  })

  it('says so plainly when the preview already covers the whole file', () => {
    const handoff = describeFullRunHandoff(
      manifest({
        subset: { applied: false, requestedCells: 2000, sampledCells: 20000, sampling: 'head' },
        fullRunRequired: false
      })
    )
    expect(handoff).toContain('The preview is the full data')
    expect(handoff).not.toContain('do not deliver as a final conclusion')
  })
})
