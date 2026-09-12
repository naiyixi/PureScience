// Engine catalog (v1.56 unit 1): one declaration per scientific engine, so the compute ladder, the
// UI and the provenance text all read the same facts instead of each re-deciding what is available.
//
// The catalog exists to make the honest answer cheap:
//   * an engine declares whether it produces a *measured* result or a *prediction* — predictions can
//     never be presented as measurements;
//   * an engine declares what it needs (GPU, multi-GB weights, a licence) so "no engine here" is a
//     computed fact rather than a guess;
//   * engines whose weights are huge are 'on-demand' and require explicit user consent before any
//     download starts (never bundled into the installer, never fetched silently).

export const ENGINE_CATALOG_SCHEMA_VERSION = 1

export type EngineKind =
  'database-lookup' | 'structure-prediction' | 'ddg-prediction' | 'ddg-physics' | 'md'

/** How the number leaves the engine: measured experiments are impossible here, so this is the
 *  honesty axis the whole app turns on. */
export type EngineOutputKind = 'measured' | 'predicted' | 'lookup'

export type EngineLicense = {
  /** SPDX-ish identifier when known. */
  id: string
  /** True when commercial use needs a paid licence or is forbidden. */
  commercialRestricted: boolean
  note?: string
}

export type EngineRequirements = {
  /** Needs a CUDA/MPS GPU to be usable at all. */
  gpuRequired: boolean
  /** Approximate local weight size in bytes; 0 when nothing is downloaded. */
  weightBytes: number
  /** Weights are fetched only after explicit consent (never bundled). */
  onDemandDownload: boolean
  /** Needs a multi-sequence alignment or other external input prep. */
  needsMsa?: boolean
}

export type EngineDefinition = {
  id: string
  label: string
  kind: EngineKind
  outputKind: EngineOutputKind
  requirements: EngineRequirements
  license: EngineLicense
  /** What the engine is good for, in one line, used in proposals. */
  summary: string
  /** Where it runs: locally, on a registered compute host, or both. */
  placement: 'local' | 'remote' | 'either'
}

export type EngineAvailabilityContext = {
  /** Whether a GPU is usable on the machine that would run the engine. */
  hasGpu: boolean
  /** Whether the user consented to on-demand weight downloads this session. */
  allowOnDemandDownload: boolean
  /** Whether a registered compute host is available for remote placement. */
  hasComputeHost: boolean
}

export type EngineAvailability =
  | { status: 'ready'; engine: EngineDefinition }
  | { status: 'needs-consent'; engine: EngineDefinition; reason: string }
  | { status: 'needs-host'; engine: EngineDefinition; reason: string }
  | { status: 'unavailable'; engine: EngineDefinition; reason: string }

export const ENGINE_CATALOG: EngineDefinition[] = [
  {
    id: 'alphafold-db',
    label: 'AlphaFold DB（数据库预测）',
    kind: 'database-lookup',
    outputKind: 'lookup',
    placement: 'local',
    summary: '按 UniProt 编号取现成预测结构；非实验结构，必须标注为数据库预测。',
    requirements: { gpuRequired: false, weightBytes: 0, onDemandDownload: false },
    license: { id: 'CC-BY-4.0', commercialRestricted: false }
  },
  {
    id: 'pdb',
    label: 'PDB（实验结构）',
    kind: 'database-lookup',
    outputKind: 'measured',
    placement: 'local',
    summary: '实验解析的结构；与预测结构不可混为一谈。',
    requirements: { gpuRequired: false, weightBytes: 0, onDemandDownload: false },
    license: { id: 'CC0-1.0', commercialRestricted: false }
  },
  {
    id: 'esmfold',
    label: 'ESMFold（本地结构预测）',
    kind: 'structure-prediction',
    outputKind: 'predicted',
    placement: 'either',
    summary: '单序列端到端折叠预测；权重数 GB，需 GPU，权重按需下载。',
    requirements: { gpuRequired: true, weightBytes: 15_000_000_000, onDemandDownload: true },
    license: { id: 'MIT-weights-terms', commercialRestricted: false, note: '需遵守权重使用条款' }
  },
  {
    id: 'colabfold',
    label: 'ColabFold / AlphaFold2（远程结构预测）',
    kind: 'structure-prediction',
    outputKind: 'predicted',
    placement: 'remote',
    summary: '需 MSA 的经典折叠管线；适合有 GPU 的远程主机。',
    requirements: {
      gpuRequired: true,
      weightBytes: 4_000_000_000,
      onDemandDownload: true,
      needsMsa: true
    },
    license: { id: 'CC-BY-4.0', commercialRestricted: false, note: '参数附带使用条款' }
  },
  {
    id: 'ddg-cpu-predictor',
    label: 'ΔΔG CPU 预测器',
    kind: 'ddg-prediction',
    outputKind: 'predicted',
    placement: 'local',
    summary: '秒级给出稳定化/去稳定化倾向；只能作为预测，必须带不确定度。',
    requirements: { gpuRequired: false, weightBytes: 200_000_000, onDemandDownload: true },
    license: { id: 'academic-use', commercialRestricted: true, note: '多为学术许可，商用需替换' }
  },
  {
    id: 'openmm-fep',
    label: 'OpenMM FEP（物理 ΔΔG）',
    kind: 'ddg-physics',
    outputKind: 'predicted',
    placement: 'remote',
    summary: '自由能微扰，GPU·天级；只在远程主机上跑，结果需收敛判据与 provenance。',
    requirements: { gpuRequired: true, weightBytes: 0, onDemandDownload: false },
    license: { id: 'MIT', commercialRestricted: false }
  },
  {
    id: 'rosetta-ddg',
    label: 'Rosetta ddg_monomer',
    kind: 'ddg-physics',
    outputKind: 'predicted',
    placement: 'remote',
    summary: '经验力场 ΔΔG；非商用免费，商用需许可。',
    requirements: { gpuRequired: false, weightBytes: 0, onDemandDownload: false },
    license: { id: 'Rosetta-noncommercial', commercialRestricted: true, note: '商用需购买许可' }
  }
]

export const findEngine = (id: string): EngineDefinition | undefined =>
  ENGINE_CATALOG.find((engine) => engine.id === id)

// Decides whether an engine can actually be used here — the single source the compute ladder and
// the UI both consult. Never returns 'ready' for an engine that needs something the context lacks.
export const evaluateEngineAvailability = (
  engine: EngineDefinition,
  context: EngineAvailabilityContext
): EngineAvailability => {
  const consentGate = (): EngineAvailability | null => {
    if (
      engine.requirements.onDemandDownload &&
      engine.requirements.weightBytes > 0 &&
      !context.allowOnDemandDownload
    ) {
      return {
        status: 'needs-consent',
        engine,
        reason: `${engine.label} 需按需下载约 ${formatWeightSize(engine.requirements.weightBytes)} 权重（需你确认，不会静默下载）`
      }
    }
    return null
  }

  // Remote-only engines live or die by whether a host is registered; GPU capability is the host's
  // problem, not something this machine can claim.
  if (engine.placement === 'remote') {
    if (!context.hasComputeHost) {
      return {
        status: 'needs-host',
        engine,
        reason: `${engine.label} 需要在已注册的计算主机上运行（当前无可用主机）`
      }
    }
    return consentGate() ?? { status: 'ready', engine }
  }

  const canRunLocally = !engine.requirements.gpuRequired || context.hasGpu
  if (!canRunLocally) {
    // 'either' engines may still run on a registered host; everything else is simply unavailable.
    if (engine.placement !== 'either' || !context.hasComputeHost) {
      return {
        status: 'unavailable',
        engine,
        reason: `${engine.label} 需要 GPU：本机没有${context.hasComputeHost ? '' : '，也没有可用的计算主机'}`
      }
    }
  }

  return consentGate() ?? { status: 'ready', engine }
}

export const formatWeightSize = (bytes: number): string => {
  if (bytes <= 0) return '无需权重'
  const gb = bytes / 1_000_000_000
  return gb >= 1 ? `约 ${gb.toFixed(0)} GB` : `约 ${(bytes / 1_000_000).toFixed(0)} MB`
}

/** Available engines for a task, best-first, with the reason each others are out. */
export const resolveEnginesForTask = (
  kind: EngineKind,
  context: EngineAvailabilityContext
): {
  ready: EngineDefinition[]
  blocked: { engine: EngineDefinition; status: string; reason: string }[]
} => {
  const ready: EngineDefinition[] = []
  const blocked: { engine: EngineDefinition; status: string; reason: string }[] = []
  for (const engine of ENGINE_CATALOG.filter((entry) => entry.kind === kind)) {
    const availability = evaluateEngineAvailability(engine, context)
    if (availability.status === 'ready') ready.push(engine)
    else blocked.push({ engine, status: availability.status, reason: availability.reason })
  }
  return { ready, blocked }
}

// The sentence that must accompany any number the engine produced.
export const describeEngineProvenance = (engine: EngineDefinition): string =>
  `引擎：${engine.label}（${engine.id}）· 输出类型：${
    engine.outputKind === 'measured'
      ? '实验测量'
      : engine.outputKind === 'lookup'
        ? '数据库查询'
        : '预测'
  }${engine.outputKind === 'predicted' ? '（非实验值，须与实验值区分标注）' : ''}`

/** Predictions must never be merged into a table of measurements without this flag being honoured. */
export const isPredictedOutput = (engine: EngineDefinition): boolean =>
  engine.outputKind === 'predicted'
