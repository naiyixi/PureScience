// 「持久目标」的工具面与记录形状：一件长期要做的事被写成一条**目标**，它跨回合、跨重启存在，
// 而它的**进度只能由应用自己取到的读数推进**（推进那一半在 goal-repository 的 advance 里，本文件只
// 定义「什么算一条读数引用」）。
//
// 为什么读数引用是记录的一部分而不是附注：一条「已完成」的验收项若说不出它是**哪一次**运行/哪一个
// 产物版本证明的，那它就是模型的一句自述 —— 与仓里「数字不许裸奔」同源。

export const GOAL_MCP_SERVER_NAME = 'purescience-goal'

export const GOAL_CONFIGURE_TOOL_NAME = 'goal_configure'
export const GOAL_STATUS_TOOL_NAME = 'goal_status'

export const GOAL_CONFIGURE_TOOL_DESCRIPTION =
  'Registers (or updates) a persistent goal: one objective, the acceptance criteria that decide it is ' +
  'finished, and nothing else. Progress is advanced only through goal_advance, which must name a reading ' +
  'the app itself took — a goal whose criteria are met only by assertion stays unmet by construction. ' +
  'Pass the same goal_id to update an existing goal instead of creating a second one.'

export const GOAL_STATUS_TOOL_DESCRIPTION =
  'Lists the goals this session owns: objective, each acceptance criterion with the reading that met it (or ' +
  'that it is unmet), the milestones in order, and the goal state. Read it after an attempt to see whether ' +
  'anything actually advanced.'

export const GOAL_MAX_OBJECTIVE_CHARS = 2_000
export const GOAL_MAX_ACCEPTANCE_ITEMS = 12
export const GOAL_MAX_MILESTONES = 64
export const GOAL_MAX_TEXT_CHARS = 500

export type GoalState = 'active' | 'achieved' | 'abandoned'

// What a progress claim has to point at. `fingerprint` is the value the app computed when it took the
// reading (a run id and its record hash, an artifact version's content hash, a connector reading's own
// published fingerprint), so the reference can be re-resolved later instead of being taken on faith.
export type GoalReadingKind = 'run' | 'artifact-version' | 'connector-reading'

export type GoalReadingRef = {
  kind: GoalReadingKind
  id: string
  fingerprint: string
}

export type GoalAcceptanceItem = {
  id: string
  text: string
  metBy: GoalReadingRef | null
}

export type GoalMilestone = {
  id: string
  text: string
  at: number
  reading: GoalReadingRef
}

export type Goal = {
  id: string
  sessionId: string
  objective: string
  acceptance: GoalAcceptanceItem[]
  milestones: GoalMilestone[]
  state: GoalState
  createdAt: number
  updatedAt: number
}

// Named refusals, one per reason a goal cannot be registered as asked. Kept apart because the caller can
// act on the difference: an empty objective is a different mistake from a criterion that says nothing.
export const GOAL_REFUSAL_CODES = [
  'empty-objective',
  'objective-too-long',
  'no-acceptance',
  'too-many-acceptance',
  'empty-acceptance-item',
  'acceptance-too-long',
  'not-found',
  'record-unreadable'
] as const

export type GoalRefusalCode = (typeof GOAL_REFUSAL_CODES)[number]
