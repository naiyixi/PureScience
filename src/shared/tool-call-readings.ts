// 一次会话里每次工具调用留下的读数：名字、耗时、结果大小、结果哈希 —— 与它们的**自述配方**。
//
// 为什么它要随会话包一起出门：包里的 `conversation.json` 只带消息（工具活动在导出时就被剥成了
// 消息上的投影，`activities` 原文并不过桥），所以「这个包里有几次工具调用、贵不贵在哪一次」在
// 接收端**无处可算**。一个算不出来的数字写进清单就只是一句自述；把读数本身带上，接收端才能把
// 清单里的三个数（行数 / 未命名活动数 / 字节摘要）逐条对回包内的字节。
//
// 配方（第三方不看我们一行代码也能复算）：
//   1. 解压包，取出 `evidence/tool-calls.json` 的**原始字节**；
//   2. 对它做 sha256（十六进制小写）——这才是清单里 `sha256` 的那个值，不是对「重新序列化一遍」
//      的结果做哈希：重新序列化的字节与服务端真发的字节可能不同，那样算出来的摘要证明不了什么；
//   3. 解析这份 JSON：`rows` 是逐条读数（长度必须等于清单里的 `rows`），`unnamed` 是导出方
//      说不出名字的工具活动条数（必须等于清单里的 `unnamed`）；
//   4. 任何一条对不上 ⇒ 这个包与它自己的记录不符。
//
// 三种缺席分开命名，绝不合成一个 0：`absent:no-tool-calls`（这次会话真的没调工具）、
// `absent:not-collected`（这一版导出器还没采这一段）、`not-recorded`（清单里没有这段声明，
// 老包）。三种都不是「一致」。
export const TOOL_CALL_READINGS_RECIPE = 'tool-call-readings:v1'

/** 包内承载逐条读数的路径。与清单里的声明一一对应。 */
export const SESSION_PACKAGE_TOOL_READINGS_PATH = 'evidence/tool-calls.json'

export type ToolCallReading = {
  turnId: string
  tool: string
  durationMs?: number
  resultBytes?: number
  resultSha256?: string
}

/** 包内文件自己的形状：读数 + 配方名 + 未命名活动数。 */
export type ToolCallReadingsDocument = {
  recipe: string
  rows: ToolCallReading[]
  unnamed: number
}

/**
 * 清单里的那句话。判别联合而不是一堆可选字段：一个「没有读数」的包不该假装自己 `rows: 0`
 * 且摘要为空 —— 那是把「没采」说成「采到零条」。
 */
export type SessionPackageToolReadings =
  | { recipe: string; state: 'included'; rows: number; unnamed: number; sha256: string }
  | { recipe: string; state: 'absent:no-tool-calls'; unnamed: number }
  | { recipe: string; state: 'absent:not-collected' }

export type ToolCallReadingsField = 'recipe' | 'rows' | 'unnamed' | 'sha256' | 'state'

export type ToolCallReadingsComparison =
  | { state: 'match'; rows: number; unnamed: number }
  | { state: 'mismatch'; fields: readonly ToolCallReadingsField[] }
  // 清单里没有这一段（老包）。不是失败，但**永远不能读成一致**。
  | { state: 'not-recorded' }
  // 声明了却读不出来：文件缺失、不是 JSON、配方不认识、形状不对。
  | { state: 'underivable'; reason: ToolCallReadingsUnreadableReason }

export type ToolCallReadingsUnreadableReason =
  'declaration-unreadable' | 'file-missing' | 'file-unparseable' | 'recipe-unknown'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

const isOptionalCount = (value: unknown): boolean => value === undefined || isCount(value)

const toReading = (value: unknown): ToolCallReading | null => {
  if (!isRecord(value)) return null
  const turnId = value.turnId
  const tool = value.tool
  if (typeof turnId !== 'string' || turnId.length === 0) return null
  if (typeof tool !== 'string' || tool.length === 0) return null
  if (!isOptionalCount(value.durationMs) || !isOptionalCount(value.resultBytes)) return null
  if (value.resultSha256 !== undefined && typeof value.resultSha256 !== 'string') return null
  return {
    turnId,
    tool,
    ...(value.durationMs !== undefined ? { durationMs: value.durationMs as number } : {}),
    ...(value.resultBytes !== undefined ? { resultBytes: value.resultBytes as number } : {}),
    ...(value.resultSha256 !== undefined ? { resultSha256: value.resultSha256 as string } : {})
  }
}

/**
 * 解析包内那份文件。返回 `null` 表示「读不出可信的读数」——调用方必须把它当作可复算失败，
 * 而不是当作零条。
 */
export const parseToolCallReadingsDocument = (text: string): ToolCallReadingsDocument | null => {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  if (typeof parsed.recipe !== 'string' || parsed.recipe.length === 0) return null
  if (!Array.isArray(parsed.rows)) return null
  if (!isCount(parsed.unnamed)) return null
  const rows: ToolCallReading[] = []
  for (const raw of parsed.rows) {
    const reading = toReading(raw)
    if (!reading) return null
    rows.push(reading)
  }
  return { recipe: parsed.recipe, rows, unnamed: parsed.unnamed }
}

const isDeclared = (value: unknown): value is SessionPackageToolReadings => {
  if (!isRecord(value)) return false
  if (typeof value.recipe !== 'string' || value.recipe.length === 0) return false
  if (value.state === 'included') {
    return isCount(value.rows) && isCount(value.unnamed) && typeof value.sha256 === 'string'
  }
  if (value.state === 'absent:no-tool-calls') return isCount(value.unnamed)
  if (value.state === 'absent:not-collected') return true
  return false
}

/**
 * 把清单里的那句话与包内实际字节对一遍。
 *
 * `carried` 由调用方（主进程）给：`sha256` 是对**包内原始字节**算的，`document` 是从同一批字节
 * 解析出来的。摘要函数不能住在这个模块里（共享层同时被渲染器编译，不许 import `node:crypto`），
 * 所以这里只做判决，不做哈希 —— 配方里第 2 步由主进程照做。
 */
export const compareToolCallReadings = (
  declared: unknown,
  carried: { sha256: string | null; document: ToolCallReadingsDocument | null }
): ToolCallReadingsComparison => {
  if (declared === undefined || declared === null) return { state: 'not-recorded' }
  if (!isDeclared(declared)) return { state: 'underivable', reason: 'declaration-unreadable' }

  if (declared.state !== 'included') {
    // 声明「这次没有工具调用」或「这一段没采」时，包里就不该出现那份文件。出现了，说明清单与
    // 内容互相矛盾 —— 那是 mismatch，不是 match。
    if (carried.document !== null || carried.sha256 !== null) {
      return { state: 'mismatch', fields: ['state'] }
    }
    return { state: 'match', rows: 0, unnamed: 0 }
  }

  if (carried.sha256 === null) return { state: 'underivable', reason: 'file-missing' }
  if (carried.document === null) return { state: 'underivable', reason: 'file-unparseable' }
  if (carried.document.recipe !== declared.recipe) {
    return { state: 'underivable', reason: 'recipe-unknown' }
  }

  const fields: ToolCallReadingsField[] = []
  if (carried.document.rows.length !== declared.rows) fields.push('rows')
  if (carried.document.unnamed !== declared.unnamed) fields.push('unnamed')
  if (carried.sha256 !== declared.sha256) fields.push('sha256')
  if (fields.length > 0) return { state: 'mismatch', fields }
  return { state: 'match', rows: declared.rows, unnamed: declared.unnamed }
}
