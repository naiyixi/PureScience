// Omics preview contract (v1.54 unit 1): the machine-readable manifest a large-file preview
// passes back to the app. The point of the contract is guardrail G6 — a downsampled read must be
// *labelled as a subset* everywhere it is shown, and the manifest is what makes that label
// derivable instead of remembered. The heavy lifting lives in the bundled Python skill
// (resources/skills/omics-data-preview); this module only defines and validates the hand-off.

export const OMICS_PREVIEW_SCHEMA_VERSION = 1

export type OmicsFormat = 'h5ad' | 'vcf' | 'vcf-gz' | 'unknown'

export type OmicsSubsetInfo = {
  applied: boolean
  /** Cells the caller asked to preview (iteration budget). */
  requestedCells: number
  /** Cells actually materialised for the preview. */
  sampledCells: number
  /** How the sample was taken: cheap head slice or seeded random sample. */
  sampling: 'head' | 'random'
}

export type OmicsPreviewManifest = {
  schemaVersion: number
  path: string
  format: OmicsFormat
  generatedAt: string
  /** Cell count (h5ad) — full-file count, not the sampled one. */
  nObs?: number
  /** Feature/gene count (h5ad). */
  nVars?: number
  /** Variant count (vcf) when the scan reached the end of the file. */
  variantCount?: number
  subset?: OmicsSubsetInfo
  /** True when a trustworthy answer requires the full data rather than the preview sample. */
  fullRunRequired: boolean
  notes: string[]
}

export const detectOmicsFormat = (path: string): OmicsFormat => {
  const lowered = path.trim().toLowerCase()
  if (lowered.endsWith('.h5ad')) return 'h5ad'
  if (lowered.endsWith('.vcf.gz') || lowered.endsWith('.vcf.bgz')) return 'vcf-gz'
  if (lowered.endsWith('.vcf')) return 'vcf'
  return 'unknown'
}

export const isOmicsPreviewManifest = (value: unknown): value is OmicsPreviewManifest => {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<OmicsPreviewManifest>
  return (
    candidate.schemaVersion === OMICS_PREVIEW_SCHEMA_VERSION &&
    typeof candidate.path === 'string' &&
    typeof candidate.format === 'string' &&
    typeof candidate.generatedAt === 'string' &&
    typeof candidate.fullRunRequired === 'boolean' &&
    Array.isArray(candidate.notes)
  )
}

// G6: how this preview must be described wherever its numbers are used.
export const describeOmicsScope = (manifest: OmicsPreviewManifest): string => {
  const total = manifest.nObs ?? manifest.variantCount
  const subset = manifest.subset
  if (subset?.applied) {
    const denominator = total !== undefined ? String(total) : '全部'
    return `基于 ${subset.sampledCells}/${denominator} 降采样（${subset.sampling === 'head' ? '头部截取' : '随机抽样'}）`
  }
  if (total !== undefined) {
    return `全量（${total}）`
  }
  return '范围未知（未取得完整计数）'
}

// True when a result built from this preview must be flagged as provisional before it is trusted.
export const isProvisionalScope = (manifest: OmicsPreviewManifest): boolean =>
  manifest.fullRunRequired || manifest.subset?.applied === true

export const summarizeOmicsPreview = (manifest: OmicsPreviewManifest): string => {
  const parts = [describeOmicsScope(manifest)]
  if (manifest.format === 'h5ad' && manifest.nObs !== undefined && manifest.nVars !== undefined) {
    parts.push(`${manifest.nObs} 细胞 × ${manifest.nVars} 特征`)
  }
  if (manifest.format === 'unknown') {
    parts.push('格式未识别（仅按字节流预览）')
  }
  if (manifest.fullRunRequired) {
    parts.push('需全量计算（走算力决策链，勿以预览结论定稿）')
  }
  return parts.join(' · ')
}
