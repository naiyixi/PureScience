import { describe, expect, it } from 'vitest'

import { en } from '../renderer/src/i18n/en'

import { OMICS_PREVIEW_SCHEMA_VERSION, type OmicsPreviewManifest } from './omics-preview'
import { describeFullRunProposal, proposeOmicsFullRun } from './omics-full-run'

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

describe('omics full-run proposal', () => {
  it('proposes nothing when the preview already covered the whole file', () => {
    expect(
      proposeOmicsFullRun(
        manifest({
          subset: { applied: false, requestedCells: 2000, sampledCells: 20000, sampling: 'head' },
          fullRunRequired: false
        }),
        {},
        t
      )
    ).toBeNull()
  })

  it('always requires approval and never claims the job was submitted (G1)', () => {
    const proposal = proposeOmicsFullRun(
      manifest(),
      { hostName: 'gpu-a', executionMode: 'slurm' },
      t
    )
    expect(proposal?.requiresApproval).toBe(true)
    const text = describeFullRunProposal(proposal!)
    expect(text).toContain('Human approval required: yes')
    expect(text).not.toContain('submitted')
    expect(text).not.toContain('has run')
  })

  it('carries the preview scope label into the reason and the required result labels', () => {
    const proposal = proposeOmicsFullRun(
      manifest(),
      {
        hostName: 'gpu-a',
        executionMode: 'direct_ssh',
        engine: 'scanpy 1.10 full matrix',
        question: '得到稳定的细胞类型比例'
      },
      t
    )!
    expect(proposal.scopeLabel).toBe('Downsampled 2000/20000 (head slice)')
    expect(proposal.reason).toContain('Downsampled 2000/20000')
    expect(proposal.reason).toContain('得到稳定的细胞类型比例')
    expect(proposal.deliverable).toContain('all 20000 cells')
    expect(proposal.deliverable).toContain('gpu-a (direct SSH)')
    expect(proposal.requiredResultLabels).toContain('Data scope: full (20000)')
    expect(proposal.requiredResultLabels).toContain('Engine and version')
  })

  it('lists what is still missing before the job could be submitted', () => {
    const proposal = proposeOmicsFullRun(manifest(), {}, t)!
    expect(proposal.missing.join('')).toContain('No compute host selected')
    expect(describeFullRunProposal(proposal)).toContain('Still missing:')
  })

  it('is honest when the preview could not establish the total size', () => {
    const proposal = proposeOmicsFullRun(
      manifest({ nObs: undefined, nVars: undefined, format: 'vcf-gz', variantCount: undefined }),
      { hostName: 'gpu-a' },
      t
    )!
    expect(proposal.deliverable).toContain('the full dataset')
    expect(proposal.notes.join('')).toContain('Full-run size unknown')
    expect(proposal.requiredResultLabels).toContain('Data scope: full (reported at runtime)')
  })

  it('asks for an engine declaration to be part of the result when none was named', () => {
    const proposal = proposeOmicsFullRun(manifest(), { hostName: 'gpu-a' }, t)!
    expect(proposal.notes.join('')).toContain('No engine specified')
    expect(proposal.requiredResultLabels).toContain('Key parameters')
  })
})
