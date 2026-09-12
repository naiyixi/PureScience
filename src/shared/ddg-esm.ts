// Zero-shot ESM ΔΔG scoring contract (v1.57 unit 4, ΔΔG Phase 1 per the engine-selection review).
//
// Why this shape: the model forward pass is a runtime, consented, on-demand step; what must be
// deterministic — and therefore testable and auditable — is how a set of per-model scores becomes a
// number we are willing to show. So this module owns the honesty rules, not the arithmetic of the
// network:
//   * a kcal/mol value requires a declared calibration factor (source + value); without one we
//     report the dimensionless log-ratio only and say why,
//   * every estimate is a prediction, carries dispersion when more than one model contributed,
//     and states the licence and model versions it came from,
//   * sign convention is fixed (negative = destabilising) instead of left to the reader.
//
// Licence: the ESM family (code and pretrained weights, incl. ESMFold) is MIT — verified against the
// project's repository metadata. Weights are never bundled: they are downloaded on demand with the
// user's consent and verified by checksum.

import { formatWeightSize } from './engine-catalog'

export type EsmDdgModelId = 'esm2-150m' | 'esm2-650m' | 'esm1v-ensemble'

export type EsmDdgModel = {
  id: EsmDdgModelId
  label: string
  parameterCount: number
  /** Approximate download size, used to describe the on-demand step. */
  weightBytes: number
  license: 'MIT'
  requiresDownloadConsent: true
  runsOnCpu: boolean
}

export const ESM_DDG_MODELS: readonly EsmDdgModel[] = [
  {
    id: 'esm2-150m',
    label: 'ESM-2 150M (zero-shot masked-marginal)',
    parameterCount: 150_000_000,
    weightBytes: 600_000_000,
    license: 'MIT',
    requiresDownloadConsent: true,
    runsOnCpu: true
  },
  {
    id: 'esm2-650m',
    label: 'ESM-2 650M (zero-shot masked-marginal)',
    parameterCount: 650_000_000,
    weightBytes: 2_600_000_000,
    license: 'MIT',
    requiresDownloadConsent: true,
    runsOnCpu: true
  },
  {
    id: 'esm1v-ensemble',
    label: 'ESM-1v 5-model ensemble (variant effect)',
    parameterCount: 650_000_000,
    weightBytes: 2_600_000_000,
    license: 'MIT',
    requiresDownloadConsent: true,
    runsOnCpu: true
  }
]

export const findEsmDdgModel = (id: string): EsmDdgModel | undefined =>
  ESM_DDG_MODELS.find((model) => model.id === id)

/** One model's score for one substitution: log P(mutant) − log P(wild type) at the mutated site. */
export type EsmScoreSet = { modelId: string; logRatio: number }

/** Calibration from log-ratio units to kcal/mol. Always explicit: value *and* provenance. */
export type EsmDdgCalibration = {
  factorKcalPerMolPerLogRatio: number
  /** Where the factor comes from (e.g. our own fit on a named benchmark subset). */
  source: string
}

export type EsmDdgEstimate =
  | {
      status: 'ok'
      /** kcal/mol, ΔΔG = ΔG(mut) − ΔG(wt): negative means destabilising. */
      deltaGkcalPerMol: number
      dispersionKcalPerMol: number
      /** Reported dispersion, in log-ratio units, before calibration. */
      dispersionLogRatio: number
      confidence: 'moderate' | 'low'
      models: { id: EsmDdgModelId; label: string; logRatio: number }[]
      provenance: string[]
      warnings: string[]
    }
  | {
      status: 'uncalibrated'
      /** Dimensionless mean log-ratio: reportable, but *not* an energy. */
      meanLogRatio: number
      models: { id: EsmDdgModelId; label: string; logRatio: number }[]
      provenance: string[]
      warnings: string[]
      message: string
    }
  | { status: 'insufficient'; message: string }

const round = (value: number, digits = 2): number => Number(value.toFixed(digits))

const mean = (values: number[]): number =>
  values.reduce((total, value) => total + value, 0) / values.length

export const estimateEsmDdg = (
  scores: readonly EsmScoreSet[],
  options: { calibration?: EsmDdgCalibration; engineVersion?: string; retrievedAt?: string } = {}
): EsmDdgEstimate => {
  const engineVersion = options.engineVersion ?? 'esm-ddG (zero-shot)'
  const retrievedAt = options.retrievedAt ?? new Date().toISOString()

  if (scores.length === 0) {
    return {
      status: 'insufficient',
      message:
        '没有可用的模型打分：未计算 ΔΔG。请先按需下载模型权重（需你同意）后重新评分，不要用定性描述替代数值。'
    }
  }

  const resolved: { id: EsmDdgModelId; label: string; logRatio: number }[] = []
  for (const score of scores) {
    const model = findEsmDdgModel(score.modelId)
    if (!model) {
      return {
        status: 'insufficient',
        message: `未知模型 ${score.modelId}；可用：${ESM_DDG_MODELS.map((m) => m.id).join(', ')}`
      }
    }
    if (!Number.isFinite(score.logRatio)) {
      return {
        status: 'insufficient',
        message: `模型 ${score.modelId} 的打分不是有限数值：结果不可用。`
      }
    }
    resolved.push({ id: model.id, label: model.label, logRatio: score.logRatio })
  }

  const values = resolved.map((entry) => entry.logRatio)
  const meanLogRatio = mean(values)
  const dispersion = values.length > 1 ? Math.max(...values) - Math.min(...values) : 0

  const baseProvenance = [
    `引擎：${engineVersion}`,
    `模型：${resolved.map((entry) => `${entry.id}=${round(entry.logRatio, 3)}`).join(' · ')}`,
    '许可：MIT（ESM 代码与预训练权重同仓；权重按需下载，不随安装包分发）',
    `检索时间：${retrievedAt}`,
    '方法：掩码边缘对数比（zero-shot），非实验测量'
  ]

  const warnings: string[] = ['该数值为预测值（predicted），不得与实验 ΔΔG 并列而不加区分。']
  if (resolved.length === 1) {
    warnings.push('仅单模型打分：无离散度估计，置信度按低处理。')
  }
  if (dispersion > 2) {
    warnings.push(
      `模型间分歧较大（跨 ${round(dispersion, 2)} 对数比单位）：结论仅在低置信度下报告。`
    )
  }

  const calibration = options.calibration
  if (!calibration) {
    return {
      status: 'uncalibrated',
      meanLogRatio: round(meanLogRatio, 3),
      models: resolved,
      provenance: baseProvenance,
      warnings,
      message:
        '未提供校准因子：只报告无量纲对数比，不给出 kcal/mol。要为能量值，必须先声明校准来源（例如在指定基准子集上自行拟合）。'
    }
  }
  if (
    !Number.isFinite(calibration.factorKcalPerMolPerLogRatio) ||
    calibration.factorKcalPerMolPerLogRatio <= 0
  ) {
    return {
      status: 'insufficient',
      message: `校准因子无效（${calibration.factorKcalPerMolPerLogRatio}）：需要 >0 的有限数值，且必须声明来源。`
    }
  }

  const factor = calibration.factorKcalPerMolPerLogRatio
  return {
    status: 'ok',
    deltaGkcalPerMol: round(meanLogRatio * factor, 2),
    dispersionKcalPerMol: round(dispersion * Math.abs(factor), 2),
    dispersionLogRatio: round(dispersion, 3),
    confidence: resolved.length > 1 && dispersion <= 2 ? 'moderate' : 'low',
    models: resolved,
    provenance: [
      ...baseProvenance,
      `校准：${factor} kcal/mol per log-ratio（来源：${calibration.source}）`,
      '符号约定：ΔΔG = ΔG(突变) − ΔG(野生型)；负值表示去稳定'
    ],
    warnings
  }
}

/** The consent text shown before a download; states size and licence, so approval is informed. */
export const describeEsmDownloadConsent = (
  modelId: string
): { ok: true; lines: string[] } | { ok: false; message: string } => {
  const model = findEsmDdgModel(modelId)
  if (!model) {
    return {
      ok: false,
      message: `未知模型 ${modelId}；可用：${ESM_DDG_MODELS.map((m) => m.id).join(', ')}`
    }
  }
  return {
    ok: true,
    lines: [
      `即将按需下载 ${model.label}`,
      `体积约 ${formatWeightSize(model.weightBytes)}（≈${model.parameterCount.toLocaleString('en-US')} 参数）`,
      `许可：${model.license}（可自由使用，含商业用途）`,
      '下载位置：应用缓存目录（不进入安装包）；完成后校验 SHA256',
      '是否继续？（拒绝则明说"未计算"，不使用定性替代）'
    ]
  }
}
