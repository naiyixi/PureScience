// Shared identity + prompt contract for the agent-facing routine MCP server. This is the
// "scheduled tasks" capability: an agent (or the user, via the settings panel) registers a
// recurring instruction with routine_configure; the main process's scheduler ticks it on
// interval and dispatches each due tick through the task runner as a fresh task run. The agent
// can inspect its schedules with routine_status and remove one with routine_cancel.

export const ROUTINE_MCP_SERVER_NAME = 'purescience-routine'

export const ROUTINE_CONFIGURE_TOOL_NAME = 'routine_configure'
export const ROUTINE_STATUS_TOOL_NAME = 'routine_status'
export const ROUTINE_CANCEL_TOOL_NAME = 'routine_cancel'

export const ROUTINE_CONFIGURE_TOOL_DESCRIPTION =
  'Registers (or updates) a recurring scheduled task. The instruction is a self-contained ' +
  'prompt for a fresh task run: when the schedule ticks, the app starts a task run with that ' +
  'instruction as its prompt. every_minutes must be an integer between 5 and 1440. Provide the ' +
  'same routine_id to update an existing schedule instead of creating a duplicate.'

export const ROUTINE_STATUS_TOOL_DESCRIPTION =
  'Lists the schedules owned by this session: id, label, interval, enabled state, next due ' +
  'time, tick/missed counts, and the last few tick results. Use it before configuring to avoid ' +
  'duplicates and after a tick to check whether the scheduled run succeeded.'

export const ROUTINE_CANCEL_TOOL_DESCRIPTION =
  'Cancels (deletes) one scheduled task by id. The id is the routine_id returned by ' +
  'routine_configure or listed by routine_status. Cancelling an already-cancelled schedule is ' +
  'a no-op success.'

// Pause reasons kept in the persisted schedule so the UI and the agent can distinguish a
// user-initiated pause from automatic back-off.
export const ROUTINE_PAUSE_REASON_USER = 'user'
export const ROUTINE_PAUSE_REASON_STUCK = 'stuck'

export type RoutinePauseReason =
  typeof ROUTINE_PAUSE_REASON_USER | typeof ROUTINE_PAUSE_REASON_STUCK

// Hard bounds mirrored from the reference scheduler: 5-minute floor keeps the tick loop cheap;
// 1440-minute ceiling keeps a schedule from becoming a de-facto one-shot.
export const ROUTINE_MIN_EVERY_MINUTES = 5
export const ROUTINE_MAX_EVERY_MINUTES = 1440

// A tick that ends in an error (task run failed / not started) increments this streak; once it
// reaches the threshold the schedule auto-pauses with reason 'stuck' so a broken routine stops
// burning task runs. The next successful tick resets the streak.
export const ROUTINE_STUCK_STREAK_THRESHOLD = 3

export type RoutineTickResult = {
  tickedAt: number
  runId?: string
  ok: boolean
  error?: string
}

// Persisted shape of one scheduled task. Stored per session in a JSON file next to the session
// (same pattern as context-summary chunks); the main process is the single writer.
export type RoutineSchedule = {
  // Stable schedule identity; returned by configure, referenced by status/cancel.
  id: string
  // The session that owns this schedule (scoping: a session only sees its own schedules).
  sessionId: string
  // Short human label shown in the settings panel; optional.
  label?: string
  // The self-contained instruction dispatched as a task-run prompt on each tick.
  instruction: string
  // Tick interval in minutes (5..1440).
  everyMinutes: number
  enabled: boolean
  // Epoch ms of the next due tick (or null when paused).
  nextDue: number | null
  // Epoch ms when the scheduler last ticked this schedule.
  lastFireAt: number | null
  // Epoch ms of the last OK tick (task run started successfully).
  lastOkAt: number | null
  tickCount: number
  missedTicks: number
  // Consecutive failed ticks; reaches ROUTINE_STUCK_STREAK_THRESHOLD → auto-pause.
  idleStreak: number
  pausedReason: RoutinePauseReason | null
  // Ring buffer of the most recent tick results (bounded).
  lastResults: RoutineTickResult[]
  createdAt: number
  updatedAt: number
}

export type RoutineConfigureRequest = {
  // Omit to create; provide to update an existing schedule.
  routineId?: string
  everyMinutes: number
  instruction: string
  label?: string
}

export type RoutineConfigureResult = {
  schedule: RoutineSchedule
}

export type RoutineStatusResult = {
  schedules: RoutineSchedule[]
}

export type RoutineCancelResult = {
  cancelled: boolean
}

// Rendered into the session prompt when the routine MCP is available.
export const ROUTINE_MCP_SYSTEM_PROMPT_APPEND = [
  '<purescience_routine_instructions>',
  'You can schedule recurring work with routine_configure(instruction=…, every_minutes=…).',
  'When the schedule ticks, the app starts a FRESH task run with your instruction as its prompt — ' +
    'so write the instruction self-contained: what to do, what to check, what to report, and ' +
    'where to put the result. A fresh run has no memory of this conversation.',
  'Use routine_status() to see what you have scheduled and whether ticks succeeded; use ' +
    'routine_cancel(id) to remove a schedule. Prefer updating an existing schedule over ' +
    'creating duplicates when the intent is the same.',
  'Schedules tick while the app runs; a schedule paused for repeated failures (reason "stuck") ' +
    'must be re-enabled before it will tick again.',
  '</purescience_routine_instructions>'
].join('\n')
