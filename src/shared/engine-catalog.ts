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
//
// Copy contract (IC42): `label` / `summary` are the **English** vocabulary of the agent-facing
// surfaces (the compute skill doc, approval scripts, logs), which are never localised; the window
// renders `labelKey` / `summaryKey` through the nine-language dictionaries instead. Keying the
// window copy is what keeps this file free of untranslatable user-visible literals — the Chinese
// that remains is the evidence/planner wording those surfaces already speak, and
// `describeEngineAvailabilityEnglish()` states the same verdict in English for the agent.

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

/** Window copy is addressed by key, so the shared catalog can stay literal-free (and translatable
 *  without being touched). Existence in the dictionaries is asserted by a source-read test. */
export type EngineCopyKey = `engines.${string}.${'label' | 'summary'}`

export type EngineDefinition = {
  id: string
  /** English name for the agent-facing surfaces. The window shows `labelKey` instead. */
  label: string
  /** i18n key of the name the window shows. */
  labelKey: EngineCopyKey
  kind: EngineKind
  outputKind: EngineOutputKind
  requirements: EngineRequirements
  license: EngineLicense
  /** What the engine is good for, in one line (English, agent-facing). */
  summary: string
  /** i18n key of the one-line description the window shows. */
  summaryKey: EngineCopyKey
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
    label: 'AlphaFold DB (database prediction)',
    labelKey: 'engines.alphafold-db.label',
    kind: 'database-lookup',
    outputKind: 'lookup',
    placement: 'local',
    summary:
      'Fetches an existing predicted structure by UniProt accession. It is not an experimental structure and must be labelled a database prediction.',
    summaryKey: 'engines.alphafold-db.summary',
    requirements: { gpuRequired: false, weightBytes: 0, onDemandDownload: false },
    license: { id: 'CC-BY-4.0', commercialRestricted: false }
  },
  {
    id: 'pdb',
    label: 'PDB (experimental structures)',
    labelKey: 'engines.pdb.label',
    kind: 'database-lookup',
    outputKind: 'measured',
    placement: 'local',
    summary:
      'Structures solved experimentally. They must never be presented alongside predictions without that distinction.',
    summaryKey: 'engines.pdb.summary',
    requirements: { gpuRequired: false, weightBytes: 0, onDemandDownload: false },
    license: { id: 'CC0-1.0', commercialRestricted: false }
  },
  {
    id: 'esmfold',
    label: 'ESMFold (local structure prediction)',
    labelKey: 'engines.esmfold.label',
    kind: 'structure-prediction',
    outputKind: 'predicted',
    placement: 'either',
    summary:
      'Single-sequence end-to-end folding; the weights are several GB, need a GPU, and are fetched on demand.',
    summaryKey: 'engines.esmfold.summary',
    requirements: { gpuRequired: true, weightBytes: 15_000_000_000, onDemandDownload: true },
    license: { id: 'MIT-weights-terms', commercialRestricted: false, note: 'weight terms apply' }
  },
  {
    id: 'colabfold',
    label: 'ColabFold / AlphaFold2 (remote structure prediction)',
    labelKey: 'engines.colabfold.label',
    kind: 'structure-prediction',
    outputKind: 'predicted',
    placement: 'remote',
    summary: 'The classic MSA-based folding pipeline; best suited to a remote host with a GPU.',
    summaryKey: 'engines.colabfold.summary',
    requirements: {
      gpuRequired: true,
      weightBytes: 4_000_000_000,
      onDemandDownload: true,
      needsMsa: true
    },
    license: { id: 'CC-BY-4.0', commercialRestricted: false, note: 'parameter terms apply' }
  },
  {
    id: 'ddg-cpu-predictor',
    label: 'ΔΔG CPU predictor',
    labelKey: 'engines.ddg-cpu-predictor.label',
    kind: 'ddg-prediction',
    outputKind: 'predicted',
    placement: 'local',
    summary:
      'Gives a stabilising/destabilising tendency in seconds; a prediction only, and it must carry an uncertainty.',
    summaryKey: 'engines.ddg-cpu-predictor.summary',
    requirements: { gpuRequired: false, weightBytes: 200_000_000, onDemandDownload: true },
    license: {
      id: 'academic-use',
      commercialRestricted: true,
      note: 'usually academic; replace for commercial use'
    }
  },
  {
    id: 'openmm-fep',
    label: 'OpenMM FEP (physics ΔΔG)',
    labelKey: 'engines.openmm-fep.label',
    kind: 'ddg-physics',
    outputKind: 'predicted',
    placement: 'remote',
    summary:
      'Free-energy perturbation, GPU and days-long; runs only on a remote host, and the result needs convergence criteria and provenance.',
    summaryKey: 'engines.openmm-fep.summary',
    requirements: { gpuRequired: true, weightBytes: 0, onDemandDownload: false },
    license: { id: 'MIT', commercialRestricted: false }
  },
  {
    id: 'rosetta-ddg',
    label: 'Rosetta ddg_monomer',
    labelKey: 'engines.rosetta-ddg.label',
    kind: 'ddg-physics',
    outputKind: 'predicted',
    placement: 'remote',
    summary:
      'Empirical force-field ΔΔG; free for non-commercial use, commercial use needs a licence.',
    summaryKey: 'engines.rosetta-ddg.summary',
    requirements: { gpuRequired: false, weightBytes: 0, onDemandDownload: false },
    license: {
      id: 'Rosetta-noncommercial',
      commercialRestricted: true,
      note: 'buy a licence for commercial use'
    }
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
        reason: `需按需下载 ${formatWeightSize(engine.requirements.weightBytes)} 权重（需你确认，不会静默下载）`
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
        reason: '需要在已注册的计算主机上运行（当前无可用主机）'
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
        reason: `需要 GPU：本机没有${context.hasComputeHost ? '' : '，也没有可用的计算主机'}`
      }
    }
  }

  return consentGate() ?? { status: 'ready', engine }
}

/**
 * English rendering of a verdict, for the agent-facing surfaces (the compute skill doc, logs), which
 * are never localised. The window renders its own copy from dictionary keys — both read the same
 * status enum, so the two can state the same fact in their reader's language without either one
 * re-deciding what is available.
 */
export const describeEngineAvailabilityEnglish = (availability: EngineAvailability): string => {
  switch (availability.status) {
    case 'ready':
      return 'available'
    case 'needs-consent':
      return `needs the user's approval before downloading ${formatWeightSize(
        availability.engine.requirements.weightBytes
      )} of weights (never downloaded silently)`
    case 'needs-host':
      return 'needs a registered compute host (none is available now)'
    case 'unavailable':
      return 'needs a GPU and this machine has not proven one'
  }
}

/** Locale-neutral on purpose: the number is interpolated into sentences that each surface writes in
 *  its own language (see the copy contract at the top of this file). */
export const formatWeightSize = (bytes: number): string => {
  if (bytes <= 0) return 'none'
  const gb = bytes / 1_000_000_000
  return gb >= 1 ? `${gb.toFixed(0)} GB` : `${(bytes / 1_000_000).toFixed(0)} MB`
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

// The sentence that must accompany any number the engine produced. It carries the engine *id* rather
// than the English display label: the id is the stable, checkable identity, and the label belongs to
// whichever surface is speaking (the window through `labelKey`).
export const describeEngineProvenance = (engine: EngineDefinition): string =>
  `引擎：${engine.id} · 输出类型：${
    engine.outputKind === 'measured'
      ? '实验测量'
      : engine.outputKind === 'lookup'
        ? '数据库查询'
        : '预测'
  }${engine.outputKind === 'predicted' ? '（非实验值，须与实验值区分标注）' : ''}`

/** Predictions must never be merged into a table of measurements without this flag being honoured. */
export const isPredictedOutput = (engine: EngineDefinition): boolean =>
  engine.outputKind === 'predicted'
