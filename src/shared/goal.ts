// 「持久目标」的工具面与记录形状：一件长期要做的事被写成一条**目标**，它跨回合、跨重启存在，
// 而它的**进度只能由应用自己取到的读数推进**（推进那一半在 goal-repository 的 advance 里，本文件只
// 定义「什么算一条读数引用」）。
//
// 为什么读数引用是记录的一部分而不是附注：一条「已完成」的验收项若说不出它是**哪一次**运行/哪一个
// 产物版本证明的，那它就是模型的一句自述 —— 与仓里「数字不许裸奔」同源。

export const GOAL_MCP_SERVER_NAME = 'purescience-goal'

export const GOAL_CONFIGURE_TOOL_NAME = 'goal_configure'
export const GOAL_STATUS_TOOL_NAME = 'goal_status'
export const GOAL_ADVANCE_TOOL_NAME = 'goal_advance'

export const GOAL_CONFIGURE_TOOL_DESCRIPTION =
  'Registers (or updates) a persistent goal: one objective, the acceptance criteria that decide it is ' +
  'finished, and nothing else. Progress is advanced only through goal_advance, which must name a reading ' +
  'the app itself took — a goal whose criteria are met only by assertion stays unmet by construction. ' +
  'Pass the same goal_id to update an existing goal instead of creating a second one.'

export const GOAL_STATUS_TOOL_DESCRIPTION =
  'Lists the goals this session owns: objective, each acceptance criterion with the reading that met it (or ' +
  'that it is unmet), the milestones in order, and the goal state. Read it after an attempt to see whether ' +
  'anything actually advanced.'

// The one tool that changes progress, and the reason the F series exists. It names a READER-applied reading
// (a run id and the fingerprint that run's source was read with) rather than a claim: the app re-resolves
// the reading itself, and stores the fingerprint IT computed. A reading that does not resolve — unknown,
// belonging to another session, or no longer matching — leaves the record byte-for-byte unchanged.
export const GOAL_ADVANCE_TOOL_DESCRIPTION =
  'Advances one acceptance criterion of a goal, and only on the strength of a reading the app itself can ' +
  're-resolve: pass reading_kind/reading_id/reading_fingerprint for a recorded run (or an artifact version, ' +
  'once that kind is wired). If the reading cannot be resolved, nothing is written and the call fails by ' +
  'name. The fingerprint stored is the one the app computes, never the one you send.'

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

// What goal_configure sends. Shared rather than owned by the store, because the RPC surface validates the
// same shape the store validates: two definitions would drift, and the drift would show up as a request the
// transport accepts and the store refuses.
export type GoalConfigureRequest = {
  goalId?: string
  objective: string
  acceptance: string[]
}

// What goal_advance sends: the criterion to advance plus the READING that grounds it. Shared for the same
// reason the configure shape is: the transport, the store and the tool schema must agree on one shape, or
// the drift shows up as a request the transport accepts and the store refuses.
export type GoalAdvanceRequest = {
  goalId: string
  // The acceptance criterion, by id or by its exact text.
  criterion: string
  // One line saying what this step did. Falls back to the criterion's own text when omitted.
  note?: string
  reading: GoalReadingRef
}

// What a SESSION-EXTERNAL reader (the settings panel) gets: every session's goals in one list, plus the
// sessions whose record exists but would not read. An unreadable record is REPORTED rather than folded
// into "that session has no goals" — the difference between "nothing was recorded" and "we could not look"
// is the whole reason the store refuses to treat a torn file as empty.
export type GoalOverview = {
  goals: Goal[]
  unreadableSessionIds: string[]
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
  'record-unreadable',
  // Progress-side refusals (goal_advance). Every one of these means the claim did not become progress.
  'criterion-not-found',
  'empty-reading-id',
  'empty-reading-fingerprint',
  'reading-not-found',
  'reading-foreign-session',
  'reading-fingerprint-mismatch',
  'too-many-milestones'
] as const

export type GoalRefusalCode = (typeof GOAL_REFUSAL_CODES)[number]

// Tells the model the goal surface exists, and states the rule it cannot negotiate: progress is advanced
// only by a reading, so a criterion it cannot point at a run or artifact version for stays unmet.
export const GOAL_MCP_SYSTEM_PROMPT_APPEND = [
  '<purescience_goal_instructions>',
  'You can keep a long-running objective with goal_configure(objective=…, acceptance=[…]). Each acceptance ' +
    'criterion is met only by a reading the app itself takes (a recorded run or an artifact version) — so ' +
    'write criteria as things a run can demonstrate, not as things you can assert.',
  'Advance progress with goal_advance(goal_id=…, criterion=…, reading_kind="run", reading_id=…, ' +
    'reading_fingerprint=…), naming a run the app recorded and the fingerprint it was read with. The app ' +
    're-resolves that reading; if it cannot, nothing is written and you get a named refusal — do not report ' +
    'progress you could not ground.',
  'Use goal_status() to read back the objective, each criterion with the reading that met it (or that it ' +
    'is unmet), and the milestones in order.',
  '</purescience_goal_instructions>'
].join('\n')
