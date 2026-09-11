import { describe, expect, it } from 'vitest'

import { OMICS_PREVIEW_SCHEMA_VERSION, type OmicsPreviewManifest } from './omics-preview'
import { describeFullRunProposal, proposeOmicsFullRun } from './omics-full-run'

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

describe('omics full-run proposal', () => {
  it('proposes nothing when the preview already covered the whole file', () => {
    expect(
      proposeOmicsFullRun(
        manifest({
          subset: { applied: false, requestedCells: 2000, sampledCells: 20000, sampling: 'head' },
          fullRunRequired: false
        })
      )
    ).toBeNull()
  })

  it('always requires approval and never claims the job was submitted (G1)', () => {
    const proposal = proposeOmicsFullRun(manifest(), { hostName: 'gpu-a', executionMode: 'slurm' })
    expect(proposal?.requiresApproval).toBe(true)
    const text = describeFullRunProposal(proposal!)
    expect(text).toContain('需人工批准：是')
    expect(text).not.toContain('已提交')
    expect(text).not.toContain('已运行')
  })

  it('carries the preview scope label into the reason and the required result labels', () => {
    const proposal = proposeOmicsFullRun(manifest(), {
      hostName: 'gpu-a',
      executionMode: 'direct_ssh',
      engine: 'scanpy 1.10 full matrix',
      question: '得到稳定的细胞类型比例'
    })!
    expect(proposal.scopeLabel).toBe('基于 2000/20000 降采样（头部截取）')
    expect(proposal.reason).toContain('基于 2000/20000 降采样')
    expect(proposal.reason).toContain('得到稳定的细胞类型比例')
    expect(proposal.deliverable).toContain('全部 20000 个细胞')
    expect(proposal.deliverable).toContain('gpu-a（直连 SSH）')
    expect(proposal.requiredResultLabels).toContain('数据范围：全量（20000）')
    expect(proposal.requiredResultLabels).toContain('引擎与版本')
  })

  it('lists what is still missing before the job could be submitted', () => {
    const proposal = proposeOmicsFullRun(manifest())!
    expect(proposal.missing.join('')).toContain('未选择计算主机')
    expect(describeFullRunProposal(proposal)).toContain('尚缺：')
  })

  it('is honest when the preview could not establish the total size', () => {
    const proposal = proposeOmicsFullRun(
      manifest({ nObs: undefined, nVars: undefined, format: 'vcf-gz', variantCount: undefined }),
      { hostName: 'gpu-a' }
    )!
    expect(proposal.deliverable).toContain('全量数据')
    expect(proposal.notes.join('')).toContain('全量规模未知')
    expect(proposal.requiredResultLabels).toContain('数据范围：全量（运行时上报）')
  })

  it('asks for an engine declaration to be part of the result when none was named', () => {
    const proposal = proposeOmicsFullRun(manifest(), { hostName: 'gpu-a' })!
    expect(proposal.notes.join('')).toContain('未指定引擎')
    expect(proposal.requiredResultLabels).toContain('关键参数')
  })
})
