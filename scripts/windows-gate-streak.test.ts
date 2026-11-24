import { describe, expect, it } from 'vitest'

import { computeWindowsStreak, httpFailureMessage, readingOf } from './windows-gate-streak.mjs'

// The gate's counting rule, pinned. Every case below is one of the shapes this repository actually produced
// on 2026-11-22, because the rule exists to survive them: runs cancelled by the next push, runs where the
// windows job finished and printed its reading before the run was cancelled, and runs that never reached it.
describe('the windows lane streak', () => {
  it('credits a run only when the reading line itself says passed', () => {
    expect(readingOf('electron P0 reading: passed')).toBe('passed')
    expect(readingOf('electron P0 reading: failed')).toBe('failed')
    expect(readingOf('build / Build windows-x64: success')).toBeUndefined()
  })

  it('reads the real job log shape: timestamped lines, and the step echoing its own command first', () => {
    const log = [
      '2026-11-22T13:39:48.3965257Z   echo "electron P0 reading: $electron_p0"',
      '2026-11-22T13:39:48.5016046Z electron P0 reading: passed'
    ].join('\n')
    expect(readingOf(log)).toBe('passed')
    // A log with only the echoed command has no reading — that is the shape that used to pass silently.
    expect(
      readingOf('2026-11-22T13:39:48.3965257Z   echo "electron P0 reading: $electron_p0"')
    ).toBeUndefined()
  })

  it('counts consecutive readings from the newest run backwards', () => {
    const result = computeWindowsStreak(
      [
        { runId: 1, reading: 'passed' },
        { runId: 2, reading: 'passed' },
        { runId: 3, reading: 'passed' }
      ],
      3
    )
    expect(result.satisfied).toBe(true)
    expect(result.credited).toEqual([1, 2, 3])
  })

  it('skips a run with no reading instead of breaking the streak, and says why', () => {
    const result = computeWindowsStreak(
      [
        { runId: 1, reading: 'passed' },
        { runId: 2, reading: undefined, reason: 'job cancelled' },
        { runId: 3, reading: 'passed' },
        { runId: 4, reading: 'passed' }
      ],
      3
    )
    expect(result.streak).toBe(3)
    expect(result.credited).toEqual([1, 3, 4])
    expect(result.skipped).toEqual([{ runId: 2, reason: 'job cancelled' }])
  })

  it('resets on a failed reading — a failure is evidence, not a gap', () => {
    const result = computeWindowsStreak(
      [
        { runId: 1, reading: 'passed' },
        { runId: 2, reading: 'failed' },
        { runId: 3, reading: 'passed' }
      ],
      3
    )
    expect(result.streak).toBe(1)
    expect(result.satisfied).toBe(false)
    expect(result.skipped[0]).toEqual({ runId: 2, reason: 'reading=failed' })
  })

  // `not-applicable` is not a cancellation: it is a named state produced by lane-status.mjs when P0 did not
  // certify that lane. Failing closed on it is the difference between "we could not measure" (skip) and "the
  // lane did not certify" (break) — a lane stuck at not-applicable must not be able to live off old greens.
  it('fails closed on a not-applicable reading, unlike a cancellation', () => {
    const result = computeWindowsStreak(
      [
        { runId: 1, reading: 'passed' },
        { runId: 2, reading: 'not-applicable' },
        { runId: 3, reading: 'passed' },
        { runId: 4, reading: 'passed' }
      ],
      3
    )
    expect(result.streak).toBe(1)
    expect(result.satisfied).toBe(false)
    expect(result.skipped[0]).toEqual({ runId: 2, reason: 'reading=not-applicable' })
  })

  it('does not reach through a failure to collect older green runs', () => {
    const result = computeWindowsStreak(
      [
        { runId: 1, reading: 'passed' },
        { runId: 2, reading: 'passed' },
        { runId: 3, reading: 'failed' },
        { runId: 4, reading: 'passed' },
        { runId: 5, reading: 'passed' }
      ],
      3
    )
    expect(result.streak).toBe(2)
    expect(result.credited).toEqual([1, 2])
  })

  it('reports not-satisfied rather than throwing when there is nothing to count', () => {
    const result = computeWindowsStreak([], 3)
    expect(result).toMatchObject({ streak: 0, satisfied: false, credited: [] })
  })

  it('names the missing token when GitHub refuses an anonymous job-log read', () => {
    // Measured 2026-11-24: run locally without a token, the gate printed
    // `windows gate streak: GitHub answered 403 for job 138070446404 logs` — indistinguishable from an
    // outage or a permissions problem, and the run it was about had the reading the gate wanted.
    expect(httpFailureMessage(403, 'job 138070446404 logs', false)).toContain(
      'no GITHUB_TOKEN/--token was supplied'
    )
    expect(httpFailureMessage(403, 'job 138070446404 logs', true)).toBe(
      'GitHub answered 403 for job 138070446404 logs'
    )
    // Only the anonymous 403 gets the extra sentence: other statuses keep the plain shape.
    expect(httpFailureMessage(404, 'job 138070446404 logs', false)).toBe(
      'GitHub answered 404 for job 138070446404 logs'
    )
  })
})
