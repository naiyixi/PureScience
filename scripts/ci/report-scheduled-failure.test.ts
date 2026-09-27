import { describe, expect, it } from 'vitest'

import { decideScheduledFailureAction, parseLaneArguments } from './report-scheduled-failure.mjs'

describe('scheduled regression tracking issue', () => {
  it('opens exactly one issue when the lane fails and none is open', () => {
    const decision = decideScheduledFailureAction({
      lanes: { vitest: 'failure', e2e: 'success' },
      openIssues: [],
      runUrl: 'https://example.test/runs/1'
    })

    expect(decision.action).toBe('create')
    expect(decision.title).toBe('Scheduled regression lane is failing')
    expect(decision.body).toContain('- `vitest`: **failure**')
    expect(decision.body).not.toContain('`e2e`')
    expect(decision.body).toContain('https://example.test/runs/1')
    // The body must carry the exact reproduction commands, otherwise the issue degrades into a badge.
    expect(decision.body).toContain('--fail-on-flaky-tests')
    expect(decision.body).toContain('check-flaky-tests.mjs')
  })

  it('comments on the open issue instead of opening duplicates', () => {
    const decision = decideScheduledFailureAction({
      lanes: { vitest: 'failure' },
      openIssues: [{ number: 41 }, { number: 42 }]
    })

    expect(decision.action).toBe('comment')
    expect(decision.issueNumber).toBe(41)
  })

  it('treats cancelled and skipped jobs as unhealthy', () => {
    // A lane that never ran proves nothing: silence must not be reported as success.
    for (const outcome of ['cancelled', 'skipped', 'timed_out']) {
      const decision = decideScheduledFailureAction({ lanes: { vitest: outcome }, openIssues: [] })
      expect(decision.action, outcome).toBe('create')
      expect(decision.body).toContain(`**${outcome}**`)
    }
  })

  it('closes the tracking issue once every lane is green', () => {
    const decision = decideScheduledFailureAction({
      lanes: { vitest: 'success', e2e: 'success' },
      openIssues: [{ number: 41 }],
      runUrl: 'https://example.test/runs/2'
    })

    expect(decision.action).toBe('close')
    expect(decision.issueNumber).toBe(41)
    expect(decision.body).toContain('Back to green')
  })

  it('does nothing when the lane is green and no issue is open', () => {
    expect(
      decideScheduledFailureAction({ lanes: { vitest: 'success' }, openIssues: [] }).action
    ).toBe('none')
  })

  it('parses lane outcomes from the workflow arguments', () => {
    expect(
      parseLaneArguments(['--lane', 'vitest=failure', '--run-url', 'x', '--lane', 'e2e=success'])
    ).toEqual({
      vitest: 'failure',
      e2e: 'success'
    })
    expect(parseLaneArguments(['--lane', 'broken'])).toEqual({})
    expect(parseLaneArguments([])).toEqual({})
  })
})
