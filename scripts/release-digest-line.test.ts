import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { formatRunLine, reduceRun, summarizeRuns } from './release-digest-line.mjs'

// What this suite holds the release digest line to: that every state a commit can be in is NAMED, and that
// the two states which carry no verdict (still running, cancelled) never read as green while also never
// being reported as a failure of that commit. A digest line that says `runs=0 … verdict=all-green` would be
// worse than no line at all — a docs-only push produces no lanes, and that is exactly the case an earlier
// reading in this repo mistook for "CI passed".

const publishScript = readFileSync(
  fileURLToPath(new URL('./publish-release.sh', import.meta.url)),
  'utf8'
)

const run = (
  name: string,
  status: string,
  conclusion: string | null,
  id = 1
): Record<string, unknown> => ({
  name,
  status,
  conclusion,
  id
})

describe('release digest line', () => {
  it('names every workflow as `name|status|conclusion`, the shape other CI readings use', () => {
    expect(formatRunLine(run('Nightly', 'completed', 'success'))).toBe('Nightly|completed|success')
    expect(formatRunLine(run('Nightly', 'in_progress', null))).toBe('Nightly|in_progress|none')
    expect(formatRunLine({})).toBe('unnamed-workflow|unknown|none')
  })

  it('calls a commit whose lanes all completed and passed `all-green`', () => {
    const summary = summarizeRuns(
      [
        run('Nightly', 'completed', 'success', 11),
        run('Windows Full Test', 'completed', 'skipped', 12)
      ],
      'abcdef1234567890'
    )
    expect(summary.verdict).toBe('all-green')
    expect(summary.redRunIds).toEqual([])
    expect(summary.digestLine).toBe(
      'digest: sha=abcdef12 runs=2 red=0 incomplete=0 verdict=all-green'
    )
  })

  it('calls a completed failure `red` and hands back the run ids the digest must be asked about', () => {
    const summary = summarizeRuns(
      [
        run('Nightly', 'completed', 'failure', 21),
        run('Windows Full Test', 'completed', 'success', 22),
        run('Scheduled Regression', 'completed', 'timed_out', 23)
      ],
      'deadbeefdeadbeef'
    )
    expect(summary.verdict).toBe('red')
    expect(summary.redRunIds).toEqual(['21', '23'])
    expect(summary.digestLine).toBe('digest: sha=deadbeef runs=3 red=2 incomplete=0 verdict=red')
  })

  it('never reads a running or cancelled lane as green, and never as a failure of this commit', () => {
    const running = summarizeRuns([run('Nightly', 'in_progress', null, 31)], 'feedfacefeedface')
    expect(running.verdict).toBe('incomplete')
    expect(running.redRunIds).toEqual([])

    const cancelled = summarizeRuns(
      [
        run('Nightly', 'completed', 'cancelled', 32),
        run('Windows Full Test', 'completed', 'success', 33)
      ],
      'feedfacefeedface'
    )
    expect(cancelled.verdict).toBe('incomplete')
    expect(cancelled.redRunIds).toEqual([])
  })

  it('names the empty case instead of deriving a pass from it', () => {
    const summary = summarizeRuns([], 'cafebabecafebabe')
    expect(summary.verdict).toBe('no-runs')
    expect(summary.lines).toEqual([])
    expect(summary.digestLine).toBe(
      'digest: sha=cafebabe runs=0 red=0 incomplete=0 verdict=no-runs'
    )
  })

  it('keeps a missing conclusion separate from a named one', () => {
    expect(reduceRun(run('Nightly', 'completed', null))).toEqual({
      name: 'Nightly',
      status: 'completed',
      conclusion: 'none',
      id: '1'
    })
  })

  it('is actually run by the release script, and that script prints the line', () => {
    // Source-level on purpose: the acceptance for this unit is "the release output carries a digest line",
    // and there is no way to build a real installer inside a unit test.
    expect(publishScript).toContain('scripts/release-digest-line.mjs')
    expect(publishScript).toMatch(/\[release\] digest:/)
  })
})
