// Full-run proposal for a previewed omics file (v1.54 unit 6). The preview says what the file is;
// this module turns that into the *proposal* the user (or agent, on the user's behalf) hands to the
// compute layer. It deliberately does not submit anything: G1 requires the job to be proposed and
// approved, and the proposal carries the labels that must survive into the result (subset vs full,
// engine/provider expectations, provenance).
//
// The execution surface is the existing compute pipeline (hosts registered in Compute settings,
// approval flow, completion notification) — no new transport is introduced here.

import { describeOmicsScope, isProvisionalScope, type OmicsPreviewManifest } from './omics-preview'

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
  options: OmicsFullRunOptions = {}
): OmicsFullRunProposal | null => {
  if (!isProvisionalScope(manifest)) return null

  const scopeLabel = describeOmicsScope(manifest)
  const question = options.question?.trim() || 'answer the analysis question'
  const total = manifest.nObs ?? manifest.variantCount
  const missing: string[] = []
  const notes: string[] = []

  if (!options.hostName) {
    missing.push('未选择计算主机（Compute 设置中注册的 SSH/Slurm 主机）')
  }
  if (total === undefined) {
    notes.push('全量规模未知：预览未能读到完整计数，作业需在运行时自行上报总量')
  }
  if (!options.engine) {
    notes.push('未指定引擎：作业脚本需声明所用引擎与版本，结果必须标注')
  }

  const target =
    total !== undefined
      ? `全部 ${total} 个${manifest.format === 'h5ad' ? '细胞' : '变异'}`
      : '全量数据'
  const host = options.hostName
    ? `${options.hostName}${options.executionMode ? `（${options.executionMode === 'slurm' ? 'Slurm 调度' : '直连 SSH'}）` : ''}`
    : '尚未选择的主机'

  return {
    requiresApproval: true,
    reason: `当前结论只能基于 ${scopeLabel}，而 ${question} 需要 ${target}。`,
    scopeLabel,
    deliverable: `在 ${host} 上运行全量分析：${options.engine ? `${options.engine} · ` : ''}覆盖 ${target}，产出可复现的数值结果。`,
    requiredResultLabels: [
      `数据范围：全量（${total !== undefined ? total : '运行时上报'}）`,
      '引擎与版本',
      '关键参数',
      '输入数据标识（路径 + 内容指纹/版本）'
    ],
    missing,
    notes
  }
}

// Rendered where the user decides; keeps the approval expectation explicit (G1).
export const describeFullRunProposal = (proposal: OmicsFullRunProposal): string => {
  const lines = [
    `提案：${proposal.deliverable}`,
    `原因：${proposal.reason}`,
    `需人工批准：是（提交前必须由用户确认主机与资源）`,
    `结果必须标注：${proposal.requiredResultLabels.join('、')}`
  ]
  if (proposal.missing.length > 0) {
    lines.push(`尚缺：${proposal.missing.join('；')}`)
  }
  if (proposal.notes.length > 0) {
    lines.push(`注意：${proposal.notes.join('；')}`)
  }
  return lines.join('\n')
}
