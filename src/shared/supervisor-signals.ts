// Supervisor wake-up policy (lightweight).
//
// The reviewer is not a permanent session watching every step: that costs a second model stream per
// run and, on evidence from comparable systems, it only pays off on hard tasks. It is woken by
// evidence that the run is going wrong, and never by routine turns. When the wake-up budget is
// exhausted, the remaining checks degrade to a post-hoc audit — and the degradation is reported, not
// hidden, so a run that skipped supervision cannot read as a run that passed it.
//
// Pure on purpose: the policy is a function over an event stream, so the wake-up and the degradation
// are unit-testable without a live agent.

export const SUPERVISOR_WAKE_KINDS = [
  // The same tool failing over and over is the strongest cheap signal that the agent is stuck.
  'repeated-tool-failure',
  // A checkpoint whose fingerprint does not match means the inputs changed under the run.
  'checkpoint-fingerprint-mismatch',
  // A rule engine already said something is wrong; supervision adds the reasoning, not the detection.
  'rule-warning',
  // Context compaction is where earlier evidence quietly leaves the window.
  'context-compaction'
] as const
export type SupervisorWakeKind = (typeof SUPERVISOR_WAKE_KINDS)[number]

// Three consecutive failures of the same tool: two can be a transient (network, a typo'd path), three
// is a loop.
export const SUPERVISOR_REPEATED_FAILURE_THRESHOLD = 3

// Wake-ups per session before supervision degrades to a post-hoc audit.
export const SUPERVISOR_DEFAULT_WAKE_BUDGET = 3

// Most urgent first: when the budget cuts the list, the surviving wakes are the ones that mean the run
// is unsound rather than merely noisy.
const WAKE_PRIORITY: readonly SupervisorWakeKind[] = [
  'checkpoint-fingerprint-mismatch',
  'repeated-tool-failure',
  'rule-warning',
  'context-compaction'
]

export type SupervisorEvent = {
  /** Turn index the event happened in, oldest first. */
  turn: number
  type: 'tool-call' | 'checkpoint' | 'rule' | 'compaction'
  /** For tool-call events: which tool, and whether the call succeeded. */
  tool?: string
  ok?: boolean
  /** For checkpoint events: whether the recorded fingerprint still matches the inputs. */
  fingerprintMatches?: boolean
  /** For rule events: how loud the rule was. */
  severity?: 'warn' | 'info'
  /** Where a human can check this for themselves (run id, artifact path, rule id). */
  evidenceHandle?: string
  detail?: string
}

export type SupervisorWake = {
  kind: SupervisorWakeKind
  atTurn: number
  evidenceHandle: string
  detail: string
}

export type SupervisorDegradation = {
  /** Why supervision could not continue at full strength (goes into the report's honesty section). */
  reason: string
  /** Wake-ups dropped by the budget, by kind. */
  skipped: SupervisorWakeKind[]
}

export type SupervisorPlan = {
  wakes: SupervisorWake[]
  degraded?: SupervisorDegradation
}

const isFailureRun = (events: readonly SupervisorEvent[], index: number): boolean => {
  const event = events[index]
  if (!event || event.type !== 'tool-call' || event.ok !== false || !event.tool) return false
  // Consecutive for THIS tool: a success of the same tool breaks the run, other tools' calls do not.
  for (let cursor = index - 1, failed = 1; cursor >= 0; cursor -= 1) {
    const previous = events[cursor]
    if (!previous || previous.type !== 'tool-call' || previous.tool !== event.tool) continue
    if (previous.ok !== false) return failed >= SUPERVISOR_REPEATED_FAILURE_THRESHOLD
    failed += 1
    if (failed >= SUPERVISOR_REPEATED_FAILURE_THRESHOLD) return true
  }
  return false
}

const detectWakes = (events: readonly SupervisorEvent[]): SupervisorWake[] => {
  const wakes: SupervisorWake[] = []
  const seen = new Set<SupervisorWakeKind>()

  const push = (wake: SupervisorWake): void => {
    // One wake per kind: a lightweight supervisor that re-fires every turn is a permanent session in
    // disguise.
    if (seen.has(wake.kind)) return
    seen.add(wake.kind)
    wakes.push(wake)
  }

  events.forEach((event, index) => {
    if (event.type === 'tool-call' && isFailureRun(events, index)) {
      push({
        kind: 'repeated-tool-failure',
        atTurn: event.turn,
        evidenceHandle:
          event.evidenceHandle ?? `turn:${event.turn}/tool:${event.tool ?? 'unknown'}`,
        detail: `${event.tool} failed ${SUPERVISOR_REPEATED_FAILURE_THRESHOLD} times in a row`
      })
    }
    if (event.type === 'checkpoint' && event.fingerprintMatches === false) {
      push({
        kind: 'checkpoint-fingerprint-mismatch',
        atTurn: event.turn,
        evidenceHandle: event.evidenceHandle ?? `turn:${event.turn}/checkpoint`,
        detail: event.detail ?? 'the checkpoint fingerprint no longer matches the inputs'
      })
    }
    if (event.type === 'rule' && event.severity === 'warn') {
      push({
        kind: 'rule-warning',
        atTurn: event.turn,
        evidenceHandle: event.evidenceHandle ?? `turn:${event.turn}/rule`,
        detail: event.detail ?? 'a rule flagged a warning'
      })
    }
    if (event.type === 'compaction') {
      push({
        kind: 'context-compaction',
        atTurn: event.turn,
        evidenceHandle: event.evidenceHandle ?? `turn:${event.turn}/compaction`,
        detail: event.detail ?? 'the context was compacted'
      })
    }
  })

  return wakes
}

/**
 * Decides which wake-ups a run has earned, honouring the budget. Over budget, the most urgent wakes
 * survive and the rest are reported as degraded to a post-hoc audit.
 */
export const planSupervisorWakes = (
  events: readonly SupervisorEvent[],
  budget: number = SUPERVISOR_DEFAULT_WAKE_BUDGET
): SupervisorPlan => {
  const wakes = detectWakes(events)
  if (wakes.length <= Math.max(0, budget)) return { wakes }

  const kept = [...wakes]
    .sort((left, right) => WAKE_PRIORITY.indexOf(left.kind) - WAKE_PRIORITY.indexOf(right.kind))
    .slice(0, Math.max(0, budget))
  // Report the surviving wakes in the order they happened, so the trace reads forward in time.
  const ordered = [...kept].sort((left, right) => left.atTurn - right.atTurn)
  const skipped = wakes.filter((wake) => !kept.includes(wake)).map((wake) => wake.kind)

  return {
    wakes: ordered,
    degraded: {
      reason:
        `supervision budget (${budget}) exceeded: ${skipped.length} later signal(s) were not acted on ` +
        `live and fall to the post-hoc audit`,
      skipped
    }
  }
}

/** One honest sentence for the traceability report's honesty section. */
export const describeSupervisorPlan = (plan: SupervisorPlan): string => {
  if (plan.wakes.length === 0 && !plan.degraded) return 'No supervisor wake-up was warranted.'
  const woken = plan.wakes.map(
    (wake) => `${wake.kind} (turn ${wake.atTurn}, ${wake.evidenceHandle})`
  )
  const lines = [`Supervisor wake-ups: ${woken.length > 0 ? woken.join('; ') : 'none'}.`]
  if (plan.degraded) {
    lines.push(`Degraded: ${plan.degraded.reason} [${plan.degraded.skipped.join(', ')}].`)
  }
  return lines.join(' ')
}

// Structural input so the policy stays decoupled from session-persistence: any entry list carrying a
// tool name and a status can feed it. `status` follows the persisted activity vocabulary.
export type SupervisorActivityLike = {
  id: string
  status: string
  providerToolName?: string
  title?: string
}

/**
 * Maps a turn's tool activities onto the policy's event stream. Only an explicit `failed` counts as a
 * failure: an activity still in progress has not failed yet, and treating it as one would wake the
 * supervisor on a slow call.
 */
export const supervisorEventsFromActivities = (
  activities: readonly SupervisorActivityLike[]
): SupervisorEvent[] =>
  activities.map((activity, index) => ({
    turn: index,
    type: 'tool-call' as const,
    tool: activity.providerToolName ?? activity.title ?? 'unknown',
    ok: activity.status !== 'failed',
    evidenceHandle: `activity:${activity.id}`
  }))

export const SUPERVISOR_PROMPT_TAG = 'supervisor_signals'

/**
 * The section appended to the reviewer's instructions when a run earned wake-ups. Empty when the
 * supervisor has nothing to say, so an ordinary turn's prompt is unchanged.
 */
export const buildSupervisorNotice = (plan: SupervisorPlan | undefined): string => {
  if (!plan || (plan.wakes.length === 0 && !plan.degraded)) return ''
  return [
    `<${SUPERVISOR_PROMPT_TAG}>`,
    describeSupervisorPlan(plan),
    'These are leads, not conclusions: verify each one against the turn evidence (the handle says where',
    'to look) and report what you find.',
    ...(plan.degraded
      ? [
          'Supervision degraded for this run: state that in your report so a skipped check cannot read as',
          'a passed one.'
        ]
      : []),
    `</${SUPERVISOR_PROMPT_TAG}>`
  ].join('\n')
}
