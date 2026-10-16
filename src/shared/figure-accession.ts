/**
 * 按图上的库号取**真实数据**（U4-b）：蛋白/生物图上的 PDB / UniProt 库号本该拿去查，查回来的东西
 * 不许由模型来编。
 *
 * 这里只放三样东西：**端点的契约**（哪个库、哪条路径）、**塑形**（把响应裁成我们对外承诺的那几个字段，
 * 缺字段就**具名缺席**而不是补一个空格）、以及**具名拒答**的理由。真正的请求发生在主进程的受管取数路径上
 * （遵应用与系统的代理设置），装配点把结果注入给读图的那一侧 —— 纯函数不做 I/O，也不猜网络。
 */
import type { FigureAccession } from './figure-understanding'

/** 库里的一条真实记录（PDB 实验条目或 AlphaFold 预测结构）。字段缺席就明说缺席。 */
export type AccessionRecord = {
  /** 库里用的标识：4 字符 PDB 号，或 `AF-<uniprot>-F1` 这样的预测模型号。 */
  id: string
  /** 这条记录是**实验**测定还是**预测**——两者不能混为一谈，所以要能分辨。 */
  basis: 'experimental' | 'predicted'
  /** 库自己给的标题，原样。 */
  title?: string
  /** 实验方法（PDB）或预测流水线（AlphaFold），原样。 */
  method?: string
  /** 分辨率（Å，PDB 有才有）。 */
  resolutionAngstroms?: number
  /** 库自己给的日期，原样（YYYYMMDD 或 ISO）。 */
  date?: string
  /** 从哪里取的，读者可核对。 */
  source: 'pdbe' | 'alphafold-db'
}

export type AccessionLookupOutcome =
  | { state: 'resolved'; records: readonly AccessionRecord[] }
  // 查过了、库里没有这条 —— 与「没查」不是一回事。
  | { state: 'not-found'; id: string }
  // 查不动：网络/代理/超时。具名，且带一句可操作的下一步。
  | { state: 'unavailable'; id: string; reason: string }

/** 端点契约：从哪取。路径与连接器里用的同一条，改这里等于同时改两条路。 */
export const PDBE_SUMMARY_BASE = 'https://www.ebi.ac.uk/pdbe/api/pdb/entry/summary'
export const ALPHAFOLD_PREDICTION_BASE = 'https://alphafold.ebi.ac.uk/api/prediction'

export const accessionLookupUrl = (accession: FigureAccession): string =>
  accession.kind === 'pdb'
    ? `${PDBE_SUMMARY_BASE}/${accession.id.toLowerCase()}`
    : `${ALPHAFOLD_PREDICTION_BASE}/${accession.id.toUpperCase()}`

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

const asText = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined

const asNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

/**
 * PDBe `/summary/<id>` 的响应：`{ "<id>": [ { title, experimental_method, resolution, release_date, ... } ] }`。
 * 塑形只取我们对外承诺的字段；库没给就说没给，不补默认值。
 */
export const shapePdbeSummary = (payload: unknown, id: string): AccessionLookupOutcome => {
  const outer = asRecord(payload)
  if (!outer) return { state: 'unavailable', id, reason: 'the entry service did not answer JSON' }
  const entries = Object.values(outer).find((value) => Array.isArray(value)) as
    unknown[] | undefined
  const first = Array.isArray(entries) ? asRecord(entries[0]) : undefined
  if (!first) return { state: 'not-found', id }
  const methods = Array.isArray(first.experimental_method)
    ? first.experimental_method.map(asText).filter((value): value is string => value !== undefined)
    : []
  const record: AccessionRecord = {
    id: asText(first.pdb_id) ?? id.toLowerCase(),
    basis: 'experimental',
    source: 'pdbe',
    ...(asText(first.title) === undefined ? {} : { title: asText(first.title) as string }),
    ...(methods.length === 0 ? {} : { method: methods.join(' / ') }),
    ...(asNumber(first.resolution) === undefined
      ? {}
      : { resolutionAngstroms: asNumber(first.resolution) as number }),
    ...(asText(first.release_date) === undefined
      ? {}
      : { date: asText(first.release_date) as string })
  }
  return { state: 'resolved', records: [record] }
}

/**
 * AlphaFold DB `/prediction/<uniprot>` 的响应：一个数组，第一项是模型。**预测结构不是实验结构** ——
 * 这条差别写在返回里（`basis: 'predicted'`），不许在界面上被抹掉。
 */
export const shapeAlphafoldPrediction = (payload: unknown, id: string): AccessionLookupOutcome => {
  if (!Array.isArray(payload)) {
    return { state: 'unavailable', id, reason: 'the prediction service did not answer a list' }
  }
  const first = asRecord(payload[0])
  if (!first) return { state: 'not-found', id }
  const record: AccessionRecord = {
    id: asText(first.modelEntityId) ?? `AF-${id.toUpperCase()}-F1`,
    basis: 'predicted',
    source: 'alphafold-db',
    ...(asText(first.toolUsed) === undefined ? {} : { method: asText(first.toolUsed) as string }),
    ...(asText(first.modelCreatedDate) === undefined
      ? {}
      : { date: asText(first.modelCreatedDate) as string })
  }
  return { state: 'resolved', records: [record] }
}

export const shapeAccessionLookup = (
  accession: FigureAccession,
  payload: unknown
): AccessionLookupOutcome =>
  accession.kind === 'pdb'
    ? shapePdbeSummary(payload, accession.id)
    : shapeAlphafoldPrediction(payload, accession.id)

/** 查不动时给读者的那一步：不是「稍后再试」，而是按这台机器能走的路重试。 */
export const accessionLookupRetryHint =
  "the lookup runs on the app's own fetch path (it follows the app and system proxy settings): " +
  'configure a proxy that can reach the entry service, or bind the accession from a machine that can.'
