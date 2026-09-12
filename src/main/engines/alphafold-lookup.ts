// AlphaFold DB lookup at the engine layer (v1.57 unit 1): the connector already knows how to talk
// to alphafold.ebi.ac.uk; this module is what the engine catalog promised — turn a lookup into a
// *declared* database prediction with provenance, or into an honest "no entry, next route" handoff.
//
// The transport is injected so the policy (what may leave the machine) stays with the connector
// layer, and so this logic is testable without network.

import {
  findEngine,
  describeEngineProvenance,
  type EngineDefinition
} from '../../shared/engine-catalog'

export type AlphaFoldModelRecord = {
  modelEntityId?: string
  entryId?: string
  providerId?: string
  toolUsed?: string
  globalMetricValue?: number
  pdbUrl?: string
  cifUrl?: string
  uniprotAccession?: string
}

export type AlphaFoldLookupOutcome =
  | {
      status: 'found'
      engine: EngineDefinition
      model: {
        entryId?: string
        providerId?: string
        toolUsed?: string
        /** Mean pLDDT as reported by the DB (a prediction-confidence metric, not accuracy). */
        plddtMean?: number
        pdbUrl?: string
        cifUrl?: string
      }
      /** Lines the surfaced result must carry so it can never be read as an experimental structure. */
      provenance: string[]
      message: string
    }
  | {
      status: 'not-found'
      engine: EngineDefinition
      /** What to do next: the caller routes to a folding engine (and its approval gate). */
      nextRoute: 'folding'
      message: string
    }
  | {
      status: 'error'
      engine: EngineDefinition
      message: string
    }

/** Injected transport: returns the raw API payload (an array of model records), or throws. A
 *  well-formed accession with no prediction is expected to resolve to an empty array. */
export type AlphaFoldPredictionFetcher = (accession: string) => Promise<AlphaFoldModelRecord[]>

const normaliseAccession = (raw: string): string => raw.trim().toUpperCase()

export const lookupAlphaFoldModel = async (
  uniprotId: string,
  fetchPrediction: AlphaFoldPredictionFetcher,
  options: { retrievedAt?: string } = {}
): Promise<AlphaFoldLookupOutcome> => {
  const engine = findEngine('alphafold-db')!
  const accession = normaliseAccession(uniprotId)
  if (!accession) {
    return { status: 'error', engine, message: '未提供 UniProt 编号：无法查询 AlphaFold DB。' }
  }

  let records: AlphaFoldModelRecord[]
  try {
    records = await fetchPrediction(accession)
  } catch (cause) {
    return {
      status: 'error',
      engine,
      message: `AlphaFold DB 查询失败（${cause instanceof Error ? cause.message : String(cause)}）；不要退回定性描述，应报告查询失败并给出重试或改用远程折叠。`
    }
  }

  // The API answers 404 with {} for "no prediction"; normalise both shapes to an empty list.
  const models = Array.isArray(records) ? records : []
  const best = models.find((model) => model.entryId || model.pdbUrl || model.cifUrl)
  if (!best) {
    return {
      status: 'not-found',
      engine,
      nextRoute: 'folding',
      message: `AlphaFold DB 无 ${accession} 的预测条目；下一步应走折叠引擎（本机或远程），并按需请求批准，而不是给出猜测结构。`
    }
  }

  const retrievedAt = options.retrievedAt ?? new Date().toISOString()
  const provenance = [
    describeEngineProvenance(engine),
    `条目：${best.entryId ?? '未知'}${best.providerId ? ` · 提供方 ${best.providerId}` : ''}${
      best.toolUsed ? ` · 工具 ${best.toolUsed}` : ''
    }`,
    `检索时间：${retrievedAt}`,
    `输入：UniProt ${accession}`,
    '此为数据库预测结构（非实验结构）；不得与 PDB 实验条目并列而不加区分。'
  ]

  return {
    status: 'found',
    engine,
    model: {
      entryId: best.entryId,
      providerId: best.providerId,
      toolUsed: best.toolUsed,
      plddtMean: typeof best.globalMetricValue === 'number' ? best.globalMetricValue : undefined,
      pdbUrl: best.pdbUrl,
      cifUrl: best.cifUrl
    },
    provenance,
    message: `已取到 ${accession} 的 AlphaFold DB 预测结构${
      typeof best.globalMetricValue === 'number'
        ? `（平均 pLDDT ${best.globalMetricValue.toFixed(1)}）`
        : ''
    }；标注为数据库预测。`
  }
}
