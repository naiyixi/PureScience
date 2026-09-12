// Supervisor wake-up policy: the reviewer is woken by evidence, not by a schedule, and a run that
// could not be supervised at full strength says so.

import { describe, expect, it } from 'vitest'

import {
  buildSupervisorNotice,
  describeSupervisorPlan,
  planSupervisorWakes,
  SUPERVISOR_DEFAULT_WAKE_BUDGET,
  SUPERVISOR_PROMPT_TAG,
  supervisorEventsFromActivities,
  type SupervisorEvent
} from './supervisor-signals'

const call = (turn: number, tool: string, ok: boolean): SupervisorEvent => ({
  turn,
  type: 'tool-call',
  tool,
  ok
})

describe('supervisor wake-up policy', () => {
  it('wakes on the third consecutive failure of the same tool, not the second', () => {
    const twoFailures = planSupervisorWakes([
      call(1, 'run_python', false),
      call(2, 'run_python', false)
    ])
    expect(twoFailures.wakes).toEqual([])

    const threeFailures = planSupervisorWakes([
      call(1, 'run_python', false),
      call(2, 'run_python', false),
      call(3, 'run_python', false)
    ])
    expect(threeFailures.wakes).toHaveLength(1)
    expect(threeFailures.wakes[0]).toMatchObject({
      kind: 'repeated-tool-failure',
      atTurn: 3,
      evidenceHandle: 'turn:3/tool:run_python'
    })
  })

  it('does not count unrelated tools or a success in between as one failure run', () => {
    const mixed = planSupervisorWakes([
      call(1, 'run_python', false),
      call(2, 'figure_review', false),
      call(3, 'checkpoint_load', false)
    ])
    expect(mixed.wakes).toEqual([])

    const recovered = planSupervisorWakes([
      call(1, 'run_python', false),
      call(2, 'run_python', false),
      call(3, 'run_python', true),
      call(4, 'run_python', false),
      call(5, 'run_python', false)
    ])
    expect(recovered.wakes).toEqual([])
  })

  it('wakes on a fingerprint mismatch, a rule warning and a compaction', () => {
    const plan = planSupervisorWakes([
      { turn: 1, type: 'checkpoint', fingerprintMatches: false, evidenceHandle: 'checkpoint:abc' },
      { turn: 2, type: 'rule', severity: 'warn', evidenceHandle: 'rule:log-axis-sanity' },
      { turn: 3, type: 'compaction' },
      { turn: 4, type: 'rule', severity: 'info' }
    ])

    expect(plan.wakes.map((wake) => wake.kind)).toEqual([
      'checkpoint-fingerprint-mismatch',
      'rule-warning',
      'context-compaction'
    ])
    expect(plan.wakes[0]?.evidenceHandle).toBe('checkpoint:abc')
    expect(plan.wakes[1]?.evidenceHandle).toBe('rule:log-axis-sanity')
    // An info-level rule is not a wake-up.
    expect(
      plan.wakes.some((wake) => wake.kind === ('rule-warning' as const) && wake.atTurn === 4)
    ).toBe(false)
  })

  it('wakes at most once per kind, so a wake is not a permanent session in disguise', () => {
    const plan = planSupervisorWakes([
      call(1, 'run_python', false),
      call(2, 'run_python', false),
      call(3, 'run_python', false),
      call(4, 'run_python', false),
      call(5, 'run_python', false)
    ])
    expect(plan.wakes).toHaveLength(1)
  })

  it('degrades to a post-hoc audit past the budget, keeping the most urgent wakes', () => {
    const plan = planSupervisorWakes(
      [
        { turn: 1, type: 'compaction' },
        { turn: 2, type: 'rule', severity: 'warn', evidenceHandle: 'rule:figure-ships-image' },
        { turn: 3, type: 'checkpoint', fingerprintMatches: false, evidenceHandle: 'checkpoint:xyz' }
      ],
      2
    )

    // The survivors are the two most urgent; they are then reported in the order they happened.
    expect(plan.wakes.map((wake) => wake.kind)).toEqual([
      'rule-warning',
      'checkpoint-fingerprint-mismatch'
    ])
    expect(plan.degraded).toEqual({
      reason: expect.stringContaining('budget (2) exceeded'),
      skipped: ['context-compaction']
    })
    // The surviving wakes read forward in time, not in priority order.
    expect(plan.wakes.map((wake) => wake.atTurn)).toEqual([2, 3])
  })

  it('never argues against an empty budget and reports it as degraded', () => {
    const plan = planSupervisorWakes(
      [call(1, 'run_python', false), call(2, 'run_python', false), call(3, 'run_python', false)],
      0
    )
    expect(plan.wakes).toEqual([])
    expect(plan.degraded?.skipped).toEqual(['repeated-tool-failure'])
  })

  it('says nothing was warranted when nothing fired, and names what fired when it did', () => {
    expect(describeSupervisorPlan(planSupervisorWakes([]))).toBe(
      'No supervisor wake-up was warranted.'
    )

    const plan = planSupervisorWakes(
      [
        { turn: 1, type: 'compaction' },
        { turn: 2, type: 'rule', severity: 'warn', evidenceHandle: 'rule:a' },
        { turn: 3, type: 'checkpoint', fingerprintMatches: false, evidenceHandle: 'checkpoint:b' }
      ],
      2
    )
    const summary = describeSupervisorPlan(plan)
    expect(summary).toContain('Supervisor wake-ups:')
    expect(summary).toContain('rule-warning (turn 2, rule:a)')
    expect(summary).toContain('checkpoint-fingerprint-mismatch (turn 3, checkpoint:b)')
    expect(summary).toContain('Degraded:')
    expect(summary).toContain('context-compaction')
  })

  it('defaults to the documented budget', () => {
    const events: SupervisorEvent[] = [
      { turn: 1, type: 'compaction' },
      { turn: 2, type: 'rule', severity: 'warn' },
      { turn: 3, type: 'checkpoint', fingerprintMatches: false },
      { turn: 4, type: 'tool-call', tool: 'run_python', ok: false },
      { turn: 5, type: 'tool-call', tool: 'run_python', ok: false },
      { turn: 6, type: 'tool-call', tool: 'run_python', ok: false }
    ]
    const plan = planSupervisorWakes(events)
    expect(plan.wakes).toHaveLength(SUPERVISOR_DEFAULT_WAKE_BUDGET)
    expect(plan.degraded?.skipped).toEqual(['context-compaction'])
  })

  it('maps tool activities onto the stream, counting only explicit failures as failures', () => {
    const events = supervisorEventsFromActivities([
      { id: 'a1', status: 'completed', providerToolName: 'run_python' },
      { id: 'a2', status: 'failed', providerToolName: 'run_python' },
      { id: 'a3', status: 'in_progress', title: 'Fetching something' },
      { id: 'a4', status: 'failed' }
    ])

    expect(events.map((event) => event.ok)).toEqual([true, false, true, false])
    expect(events[1]).toMatchObject({ tool: 'run_python', evidenceHandle: 'activity:a2' })
    // A title stands in when the provider name is absent; a nameless failure stays addressable.
    expect(events[2]).toMatchObject({ tool: 'Fetching something' })
    expect(events[3]).toMatchObject({ tool: 'unknown', evidenceHandle: 'activity:a4' })

    // Three explicit failures of one tool really do wake the supervisor through this mapping.
    const plan = planSupervisorWakes(
      supervisorEventsFromActivities([
        { id: 'f1', status: 'failed', providerToolName: 'run_python' },
        { id: 'f2', status: 'failed', providerToolName: 'run_python' },
        { id: 'f3', status: 'failed', providerToolName: 'run_python' }
      ])
    )
    expect(plan.wakes[0]).toMatchObject({
      kind: 'repeated-tool-failure',
      evidenceHandle: 'activity:f3'
    })
  })

  it('builds no prompt section when the supervisor has nothing to say', () => {
    expect(buildSupervisorNotice(undefined)).toBe('')
    expect(buildSupervisorNotice({ wakes: [] })).toBe('')
  })

  it('tells the reviewer to verify the leads and to report a degraded run', () => {
    const plan = planSupervisorWakes(
      [
        { turn: 1, type: 'compaction' },
        { turn: 2, type: 'rule', severity: 'warn', evidenceHandle: 'rule:a' },
        { turn: 3, type: 'checkpoint', fingerprintMatches: false, evidenceHandle: 'checkpoint:b' }
      ],
      2
    )
    const notice = buildSupervisorNotice(plan)

    expect(notice.startsWith(`<${SUPERVISOR_PROMPT_TAG}>`)).toBe(true)
    expect(notice).toContain('rule-warning (turn 2, rule:a)')
    expect(notice).toContain('leads, not conclusions')
    expect(notice).toContain('Supervision degraded for this run')
    // Without degradation the honesty sentence is absent, so an ordinary run reads normally.
    const clean = buildSupervisorNotice({ wakes: plan.wakes })
    expect(clean).toContain('leads, not conclusions')
    expect(clean).not.toContain('degraded')
  })
})
