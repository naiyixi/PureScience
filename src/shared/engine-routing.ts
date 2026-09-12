// Engine routing (v1.56 unit 4): turns a scientific request into the one route that can actually
// serve it here — a database lookup, an approval-gated remote job, a consented local prediction, or
// a plain "not computed". This is where the catalog stops being a table and starts deciding.
//
// Nothing here executes anything: the route is a plan plus the provenance lines its result must
// carry, so the caller (UI or agent) still has to go through the compute approval flow (G1).

import {
  describeEngineProvenance,
  evaluateEngineAvailability,
  findEngine,
  isPredictedOutput,
  resolveEnginesForTask,
  type EngineAvailabilityContext,
  type EngineDefinition
} from './engine-catalog'

export type StructureIdentifier = { kind: 'pdb' | 'uniprot'; id: string }

export type EngineRoute =
  | {
      kind: 'database-lookup'
      engine: EngineDefinition
      requiresApproval: false
      /** Provenance lines the result must carry. */
      provenance: string[]
      message: string
    }
  | {
      kind: 'remote-job'
      engine: EngineDefinition
      requiresApproval: true
      provenance: string[]
      message: string
    }
  | {
      kind: 'local-job'
      engine: EngineDefinition
      requiresApproval: false
      provenance: string[]
      message: string
    }
  | {
      kind: 'needs-consent'
      engine: EngineDefinition
      requiresApproval: false
      provenance: string[]
      message: string
    }
  | {
      kind: 'not-computed'
      requiresApproval: false
      provenance: []
      message: string
    }

const provenanceFor = (engine: EngineDefinition): string[] => [
  describeEngineProvenance(engine),
  `许可：${engine.license.id}${engine.license.commercialRestricted ? '（商用受限）' : ''}`
]

// Structure: an experimental PDB entry is a measurement; an AlphaFold DB entry is a database
// prediction; only when neither exists do we talk about running a folding engine. The context is
// accepted for call-site symmetry with the other planners (a lookup needs no engine availability).
export const planStructureRoute = (
  identifier: StructureIdentifier,
  _context: EngineAvailabilityContext
): EngineRoute => {
  if (identifier.kind === 'pdb') {
    const engine = findEngine('pdb')!
    return {
      kind: 'database-lookup',
      engine,
      requiresApproval: false,
      provenance: provenanceFor(engine),
      message: `按 PDB 编号 ${identifier.id} 取实验结构（测量值）。`
    }
  }

  const dbEngine = findEngine('alphafold-db')!
  return {
    kind: 'database-lookup',
    engine: dbEngine,
    requiresApproval: false,
    provenance: provenanceFor(dbEngine),
    message: `按 UniProt ${identifier.id} 取 AlphaFold DB 预测结构——**这是数据库预测，不是实验结构**；若该条目缺失，再走折叠引擎。`
  }
}

// De novo folding (no database entry): prefer something runnable here; if the engine needs a GPU
// this machine lacks, it only runs as an approval-gated remote job.
const runsHere = (engine: EngineDefinition, context: EngineAvailabilityContext): boolean =>
  !engine.requirements.gpuRequired || context.hasGpu

const reasonsFor = (blocked: { engine: EngineDefinition; reason: string }[]): string =>
  blocked.map((entry) => entry.reason).join('；') || '没有可用引擎'

export const planFoldingRoute = (context: EngineAvailabilityContext): EngineRoute => {
  const { ready, blocked } = resolveEnginesForTask('structure-prediction', context)
  const candidates = [...ready, ...blocked.map((entry) => entry.engine)]

  for (const engine of candidates) {
    const availability = evaluateEngineAvailability(engine, context)
    if (availability.status === 'needs-consent') {
      return {
        kind: 'needs-consent',
        engine,
        requiresApproval: false,
        provenance: provenanceFor(engine),
        message: availability.reason
      }
    }
    if (availability.status !== 'ready') continue
    if (runsHere(engine, context)) {
      return {
        kind: 'local-job',
        engine,
        requiresApproval: false,
        provenance: provenanceFor(engine),
        message: `${engine.label} 可在本机运行（预测输出，须标注）。`
      }
    }
    return {
      kind: 'remote-job',
      engine,
      requiresApproval: true,
      provenance: provenanceFor(engine),
      message: `${engine.label} 需要 GPU：本机没有，只能在计算主机上运行——提交前必须人工批准主机与资源。`
    }
  }

  return {
    kind: 'not-computed',
    requiresApproval: false,
    provenance: [],
    message: `未计算：本机与已注册主机都无法提供折叠引擎（${reasonsFor(blocked)}）。请配置 GPU 主机或启用按需下载。`
  }
}

// ΔΔG: physics engines only ever run remotely and behind approval; a CPU predictor is a consented
// local shortcut whose number must be labelled as a prediction.
export const planDdgRoute = (context: EngineAvailabilityContext): EngineRoute => {
  const physics = resolveEnginesForTask('ddg-physics', context)
  for (const engine of [...physics.ready, ...physics.blocked.map((entry) => entry.engine)]) {
    const availability = evaluateEngineAvailability(engine, context)
    if (availability.status === 'needs-consent') {
      return {
        kind: 'needs-consent',
        engine,
        requiresApproval: false,
        provenance: provenanceFor(engine),
        message: availability.reason
      }
    }
    if (availability.status === 'ready') {
      return {
        kind: 'remote-job',
        engine,
        requiresApproval: true,
        provenance: provenanceFor(engine),
        message: `${engine.label} 只能在远程主机上运行：必须人工批准；结果需附收敛判据与 provenance。`
      }
    }
  }

  const predictors = resolveEnginesForTask('ddg-prediction', context)
  for (const engine of [...predictors.ready, ...predictors.blocked.map((entry) => entry.engine)]) {
    const availability = evaluateEngineAvailability(engine, context)
    if (availability.status === 'needs-consent') {
      return {
        kind: 'needs-consent',
        engine,
        requiresApproval: false,
        provenance: provenanceFor(engine),
        message: `${availability.reason}；启用后得到的仍是预测值，必须标注并与实验值区分。`
      }
    }
    if (availability.status === 'ready') {
      return {
        kind: 'local-job',
        engine,
        requiresApproval: false,
        provenance: provenanceFor(engine),
        message: `${engine.label} 给出倾向性 ΔΔG（预测值，需带不确定度，不得当作测量）。`
      }
    }
  }

  const reasons = [...physics.blocked, ...predictors.blocked].map((entry) => entry.reason)
  return {
    kind: 'not-computed',
    requiresApproval: false,
    provenance: [],
    message: `未计算：没有可用的 ΔΔG 引擎或主机（${reasons.join('；')}）。不要用定性描述替代数值。`
  }
}

/** Every predicted route must state that its number is not a measurement. */
export const routeProvenanceIsHonest = (route: EngineRoute): boolean => {
  if (route.kind === 'not-computed') return route.provenance.length === 0
  const engine = route.engine
  if (!isPredictedOutput(engine)) return true
  return route.provenance.some((line) => line.includes('预测'))
}
