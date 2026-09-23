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

/**
 * Renderer-supplied translator. Shared code decides which key is needed and fills its own
 * variables, so the same helper works whether the caller passes a real dictionary lookup or the
 * non-interpolating English fallback some test harnesses use.
 */
export type OmicsTranslate = (key: string) => string

const fill = (template: string, vars: Record<string, string | number>): string =>
  Object.entries(vars).reduce(
    (text, [name, value]) => text.split(`{${name}}`).join(String(value)),
    template
  )

export const describeOmicsScope = (manifest: OmicsPreviewManifest, t: OmicsTranslate): string => {
  const total = manifest.nObs ?? manifest.variantCount
  const subset = manifest.subset
  if (subset?.applied) {
    const denominator = total !== undefined ? String(total) : t('omics.scopeAll')
    return fill(t('omics.scopeDownsampled'), {
      shown: subset.sampledCells,
      total: denominator,
      sampling: subset.sampling === 'head' ? t('omics.samplingHead') : t('omics.samplingRandom')
    })
  }
  if (total !== undefined) {
    return fill(t('omics.scopeFull'), { total })
  }
  return t('omics.scopeUnknown')
}

// True when a result built from this preview must be flagged as provisional before it is trusted.
/**
 * English wording of the scope, for the agent-facing instruction text: the instruction must read
 * the same in every locale, so it cannot borrow the UI dictionary.
 */
const describeOmicsScopeEnglish = (manifest: OmicsPreviewManifest): string => {
  const total = manifest.nObs ?? manifest.variantCount
  const subset = manifest.subset
  if (subset?.applied) {
    const denominator = total !== undefined ? String(total) : 'all'
    return `downsampled ${subset.sampledCells}/${denominator} (${
      subset.sampling === 'head' ? 'head slice' : 'random sample'
    })`
  }
  return total !== undefined ? `full data (${total})` : 'scope unknown (no complete count)'
}

export const isProvisionalScope = (manifest: OmicsPreviewManifest): boolean =>
  manifest.fullRunRequired || manifest.subset?.applied === true

export const summarizeOmicsPreview = (
  manifest: OmicsPreviewManifest,
  t: OmicsTranslate
): string => {
  const parts = [describeOmicsScope(manifest, t)]
  if (manifest.format === 'h5ad' && manifest.nObs !== undefined && manifest.nVars !== undefined) {
    parts.push(fill(t('omics.shapeCells'), { cells: manifest.nObs, vars: manifest.nVars }))
  }
  if (manifest.format === 'unknown') {
    parts.push(t('omics.formatUnknown'))
  }
  if (manifest.fullRunRequired) {
    parts.push(t('omics.fullRunRequired'))
  }
  return parts.join(' · ')
}

// G1: whether the preview alone may answer the user's question. A provisional scope may be used to
// plan and to sanity-check, but the answer itself has to come from the full run.
export const canAnswerFromPreview = (manifest: OmicsPreviewManifest): boolean =>
  !isProvisionalScope(manifest)

// G1: what the agent must do next when the preview is not enough — stated as an instruction so it
// cannot be skipped silently, and always without promising a number that no engine has produced.
// Agent-facing instruction, deliberately single-language: an instruction the agent reads must not
// change with the user's UI language, or the same manifest would be acted on differently per locale.
export const describeFullRunHandoff = (manifest: OmicsPreviewManifest): string => {
  if (canAnswerFromPreview(manifest)) {
    return `The preview is the full data (${describeOmicsScopeEnglish(manifest)}); it may support conclusions, but the data source and version must still be labelled.`
  }
  const scope = describeOmicsScopeEnglish(manifest)
  return [
    `Preview scope: ${scope} — do not deliver as a final conclusion.`,
    'The next step must go through the compute decision chain: (1) propose a full run (naming the host/scheduler and resources) and wait for approval;',
    '(2) if no compute is available, say plainly "not computed: <what is missing>, needs <engine or host>" — never substitute qualitative wording or preview numbers;',
    '(3) once the full run returns, label the result with provenance (engine/version/parameters/inputs).'
  ].join('\n')
}
