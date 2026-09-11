import { describe, expect, it } from 'vitest'

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
    expect(describeOmicsScope(manifest())).toBe('基于 2000/20000 降采样（头部截取）')
    expect(
      describeOmicsScope(
        manifest({
          subset: { applied: true, requestedCells: 2000, sampledCells: 1500, sampling: 'random' }
        })
      )
    ).toBe('基于 1500/20000 降采样（随机抽样）')
    expect(describeOmicsScope(manifest({ subset: undefined, fullRunRequired: false }))).toBe(
      '全量（20000）'
    )
  })

  it('stays honest when the total count is unknown', () => {
    const streaming = manifest({
      nObs: undefined,
      nVars: undefined,
      format: 'vcf-gz',
      variantCount: undefined
    })
    expect(describeOmicsScope(streaming)).toBe('基于 2000/全部 降采样（头部截取）')
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
    const summary = summarizeOmicsPreview(manifest())
    expect(summary).toContain('基于 2000/20000 降采样')
    expect(summary).toContain('20000 细胞 × 3000 特征')
    expect(summary).toContain('需全量计算')
    expect(
      summarizeOmicsPreview(manifest({ format: 'unknown', nObs: undefined, nVars: undefined }))
    ).toContain('格式未识别')
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
    expect(handoff).toContain('不得作为最终结论')
    expect(handoff).toContain('等待批准')
    expect(handoff).toContain('未计算')
    expect(handoff).toContain('provenance')
  })

  it('says so plainly when the preview already covers the whole file', () => {
    const handoff = describeFullRunHandoff(
      manifest({
        subset: { applied: false, requestedCells: 2000, sampledCells: 20000, sampling: 'head' },
        fullRunRequired: false
      })
    )
    expect(handoff).toContain('预览即全量')
    expect(handoff).not.toContain('不得作为最终结论')
  })
})
