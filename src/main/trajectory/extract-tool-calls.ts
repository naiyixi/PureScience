// 从会话文档里抽工具调用（轨迹包的 `tool-calls.jsonl`）。
//
// 口径来自 `shared/bench-evidence.ts`：会话把工具调用记在 `activities` 上，名字优先取
// `providerToolName`，退化到 `toolKind`，再退化到 `title`。这里不新造来源，也不猜：拿不到名字的
// activity 跳过并计数，而不是写一个 `tool: "unknown"` 冒充证据。
//
// 只出结构：名字、耗时、结果大小/哈希；不包含参数与结果正文（那是 `includeContent` 管的东西，
// 而轨迹包默认连正文都只放会话文档里的那份）。

import type { TrajectoryToolCall } from './bundle-payload'

type ActivityLike = {
  id?: unknown
  providerToolName?: unknown
  toolKind?: unknown
  title?: unknown
  turnId?: unknown
  status?: unknown
  startedAt?: unknown
  completedAt?: unknown
  durationMs?: unknown
  outputBytes?: unknown
}

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined

const asNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

const durationOf = (activity: ActivityLike): number | undefined => {
  const explicit = asNumber(activity.durationMs)
  if (explicit !== undefined) return explicit
  const started = asNumber(activity.startedAt)
  const completed = asNumber(activity.completedAt)
  if (started === undefined || completed === undefined) return undefined
  const span = completed - started
  return span >= 0 ? span : undefined
}

export type ToolCallExtraction = {
  calls: TrajectoryToolCall[]
  /** activities that carried no usable tool name — named rather than silently dropped. */
  unnamed: number
}

export const extractToolCalls = (session: unknown): ToolCallExtraction => {
  if (typeof session !== 'object' || session === null) return { calls: [], unnamed: 0 }
  const activities = (session as { activities?: unknown }).activities
  if (!Array.isArray(activities)) return { calls: [], unnamed: 0 }

  const calls: TrajectoryToolCall[] = []
  let unnamed = 0
  for (const raw of activities) {
    if (typeof raw !== 'object' || raw === null) continue
    const activity = raw as ActivityLike
    const tool =
      asString(activity.providerToolName) ?? asString(activity.toolKind) ?? asString(activity.title)
    if (!tool) {
      unnamed += 1
      continue
    }
    const turnId =
      asString(activity.id) ?? asString(activity.turnId) ?? `activity-${calls.length + 1}`
    calls.push({
      turnId,
      tool,
      ...(durationOf(activity) !== undefined ? { durationMs: durationOf(activity) } : {}),
      ...(asNumber(activity.outputBytes) !== undefined
        ? { resultBytes: asNumber(activity.outputBytes) }
        : {})
    })
  }
  return { calls, unnamed }
}
