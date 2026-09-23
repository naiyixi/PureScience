// Full-run proposal for a previewed omics file (v1.54 unit 6). The preview says what the file is;
// this module turns that into the *proposal* the user (or agent, on the user's behalf) hands to the
// compute layer. It deliberately does not submit anything: G1 requires the job to be proposed and
// approved, and the proposal carries the labels that must survive into the result (subset vs full,
// engine/provider expectations, provenance).
//
// The execution surface is the existing compute pipeline (hosts registered in Compute settings,
// approval flow, completion notification) — no new transport is introduced here.

import {
  describeOmicsScope,
  isProvisionalScope,
  type OmicsPreviewManifest,
  type OmicsTranslate
} from './omics-preview'

const fill = (template: string, vars: Record<string, string | number>): string =>
  Object.entries(vars).reduce(
    (text, [name, value]) => text.split(`{${name}}`).join(String(value)),
    template
  )

export type OmicsFullRunProposal = {
  /** Always true: the compute pipeline owns the approval gate. */
  requiresApproval: true
  /** Why the full run is the only way to answer the question. */
  reason: string
  /** What the run must cover (scope label that has to be reported back with the result). */
  scopeLabel: string
  /** Human-readable statement of what has to be produced, engine included when known. */
  deliverable: string
  /** Labels the finished job's result must carry. */
  requiredResultLabels: string[]
  /** What the proposal still lacks before it can be submitted. */
  missing: string[]
  notes: string[]
}

export type OmicsFullRunOptions = {
  /** Registered compute host chosen by the user, when one has been picked. */
  hostName?: string
  /** Whether the chosen host reports a scheduler (slurm) or direct SSH. */
  executionMode?: 'direct_ssh' | 'slurm'
  /** Engine the analysis needs (e.g. 'scanpy full matrix', 'OpenMM', 'ESMFold'). */
  engine?: string
  /** Question the full run must answer; defaults to the generic 'answer the analysis question'. */
  question?: string
}

// Returns null when the preview already covers the whole file: a full run would be busywork, and
// proposing one would quietly contradict the manifest it came from.
export const proposeOmicsFullRun = (
  manifest: OmicsPreviewManifest,
  options: OmicsFullRunOptions = {},
  t: OmicsTranslate
): OmicsFullRunProposal | null => {
  if (!isProvisionalScope(manifest)) return null

  const scopeLabel = describeOmicsScope(manifest, t)
  const question = options.question?.trim() || 'answer the analysis question'
  const total = manifest.nObs ?? manifest.variantCount
  const missing: string[] = []
  const notes: string[] = []

  if (!options.hostName) {
    missing.push(t('omics.missingHost'))
  }
  if (total === undefined) {
    notes.push(t('omics.noteSizeUnknown'))
  }
  if (!options.engine) {
    notes.push(t('omics.noteNoEngine'))
  }

  const target =
    total !== undefined
      ? fill(t('omics.targetAll'), {
          count: total,
          unit: manifest.format === 'h5ad' ? t('omics.unitCells') : t('omics.unitVariants')
        })
      : t('omics.targetFullData')
  const host = !options.hostName
    ? t('omics.hostUnset')
    : options.executionMode === 'slurm'
      ? fill(t('omics.hostSlurm'), { host: options.hostName })
      : options.executionMode === 'direct_ssh'
        ? fill(t('omics.hostSsh'), { host: options.hostName })
        : options.hostName

  return {
    requiresApproval: true,
    reason: fill(t('omics.reason'), { scope: scopeLabel, question, target }),
    scopeLabel,
    deliverable: fill(t('omics.deliverable'), {
      host,
      engine: options.engine ? `${options.engine} · ` : '',
      target
    }),
    requiredResultLabels: [
      fill(t('omics.labelScope'), {
        total: total !== undefined ? total : t('omics.runtimeReported')
      }),
      t('omics.labelEngine'),
      t('omics.labelParams'),
      t('omics.labelInput')
    ],
    missing,
    notes
  }
}

// The single-language rendering of a proposal, for callers that are not the panel (agent tools,
// logs, handoffs). It is deliberately not localised: the same proposal must read the same wherever
// it is quoted, and the panel renders the fields itself through the dictionary.
export const describeFullRunProposal = (proposal: OmicsFullRunProposal): string => {
  const lines = [
    `Proposal: ${proposal.deliverable}`,
    `Reason: ${proposal.reason}`,
    'Human approval required: yes (the user confirms host and resources before submission)',
    `Results must be labelled with: ${proposal.requiredResultLabels.join(', ')}`
  ]
  if (proposal.missing.length > 0) {
    lines.push(`Still missing: ${proposal.missing.join('; ')}`)
  }
  if (proposal.notes.length > 0) {
    lines.push(`Notes: ${proposal.notes.join('; ')}`)
  }
  return lines.join('\n')
}
