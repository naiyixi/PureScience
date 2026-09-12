// Remote engine job templates (v1.57 unit 2): the script skeleton a user approves before anything
// is submitted, generated *from the engine catalog* so the provenance and licence facts travel with
// the job instead of being remembered by whoever wrote the command.
//
// Nothing here submits anything: the template is produced for review, states that approval is
// required, and refuses to build a job for an engine that is not in the catalog.

import {
  ENGINE_CATALOG,
  findEngine,
  formatWeightSize,
  isPredictedOutput,
  type EngineDefinition
} from './engine-catalog'

export type RemoteJobHost = {
  name: string
  executionMode: 'direct_ssh' | 'slurm'
  /** Accelerators reported by the host probe, when the probe ran. */
  gpus?: { type: string; count: number }[]
}

export type EngineJobTemplateRequest = {
  engineId: string
  host: RemoteJobHost
  /** The analysis command to run on the host (engine invocation, not the surrounding plumbing). */
  command: string
  resources?: {
    partition?: string
    cpus?: number
    memoryGb?: number
    gpus?: number
    walltime?: string
  }
  /** Labels the produced result must carry back (defaults to the engine's own requirements). */
  extraResultLabels?: string[]
}

export type EngineJobTemplate =
  | {
      status: 'ok'
      engine: EngineDefinition
      /** Script intended for human review before submission. */
      script: string
      /** Lines the harvested result must show. */
      requiredResultLabels: string[]
      /** Things the reviewer must know (licence, GPU fit, prediction status). */
      warnings: string[]
      requiresApproval: true
    }
  | { status: 'unknown-engine'; message: string }

const ENGINE_LIST = ENGINE_CATALOG.map((engine) => engine.id).join(', ')

const baseResultLabels = (engine: EngineDefinition): string[] => [
  `引擎与版本：${engine.label}`,
  '命令与参数',
  '输入数据标识（路径 + 指纹/版本）'
]

export const buildEngineJobTemplate = (request: EngineJobTemplateRequest): EngineJobTemplate => {
  const engine = findEngine(request.engineId)
  if (!engine) {
    return {
      status: 'unknown-engine',
      message: `未知引擎 ${request.engineId}；可用：${ENGINE_LIST}`
    }
  }

  const warnings: string[] = []
  if (engine.license.commercialRestricted) {
    warnings.push(`许可提示：${engine.license.id} 商用受限——若用于商业研究，需先取得授权。`)
  }
  if (isPredictedOutput(engine)) {
    warnings.push('该引擎输出为预测值：结果必须标注 predicted，且不得与实验值并列而不加区分。')
  }
  if (engine.requirements.gpuRequired) {
    const gpuCount = (request.host.gpus ?? []).reduce((total, gpu) => total + gpu.count, 0)
    if (gpuCount === 0) {
      warnings.push('该引擎需要 GPU，但主机探测未报告加速器：提交前请确认主机确实具备 GPU。')
    }
  }
  if (engine.requirements.weightBytes > 0 && engine.requirements.onDemandDownload) {
    warnings.push(
      `该引擎需要 ${formatWeightSize(engine.requirements.weightBytes)} 权重：主机上首次运行需按需下载（需批准）。`
    )
  }
  if (engine.requirements.needsMsa) {
    warnings.push('该引擎需要多序列比对（MSA）输入：请确认 MSA 已生成或由作业自行生成。')
  }

  const labels = [...baseResultLabels(engine), ...(request.extraResultLabels ?? [])]
  const resources = request.resources ?? {}
  const provenanceHeader = [
    `# Engine: ${engine.id} (${engine.label})`,
    `# Output kind: ${engine.outputKind}${isPredictedOutput(engine) ? ' — PREDICTED, must be labelled' : ''}`,
    `# License: ${engine.license.id}${engine.license.commercialRestricted ? ' (commercial use restricted)' : ''}`,
    `# Host: ${request.host.name} (${request.host.executionMode === 'slurm' ? 'slurm' : 'direct ssh'})`,
    `# Approval: this script must be reviewed and approved by the user before submission.`
  ].join('\n')

  const labelBlock = labels.map((label) => `# result must report: ${label}`).join('\n')

  if (request.host.executionMode === 'slurm') {
    const directives = [
      '#SBATCH --job-name=PureScience-engine-job',
      `#SBATCH --partition=${resources.partition ?? '<partition>'}`,
      `#SBATCH --cpus-per-task=${resources.cpus ?? 4}`,
      `#SBATCH --mem=${resources.memoryGb ?? 16}G`,
      resources.gpus ? `#SBATCH --gres=gpu:${resources.gpus}` : null,
      `#SBATCH --time=${resources.walltime ?? '24:00:00'}`,
      '#SBATCH --output=PureScience-%j.out',
      '#SBATCH --error=PureScience-%j.err'
    ]
      .filter((line): line is string => line !== null)
      .join('\n')

    return {
      status: 'ok',
      engine,
      requiresApproval: true,
      warnings,
      requiredResultLabels: labels,
      script: [
        '#!/usr/bin/env bash',
        provenanceHeader,
        labelBlock,
        '#',
        directives,
        'set -euo pipefail',
        `echo "[engine] ${engine.id} starting at $(date -Iseconds)"`,
        request.command.trim(),
        `echo "[engine] ${engine.id} finished at $(date -Iseconds)"`
      ].join('\n')
    }
  }

  return {
    status: 'ok',
    engine,
    requiresApproval: true,
    warnings,
    requiredResultLabels: labels,
    script: [
      '#!/usr/bin/env bash',
      provenanceHeader,
      labelBlock,
      'set -euo pipefail',
      `echo "[engine] ${engine.id} starting at $(date -Iseconds)"`,
      request.command.trim(),
      `echo "[engine] ${engine.id} finished at $(date -Iseconds)"`
    ].join('\n')
  }
}
