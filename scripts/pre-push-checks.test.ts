import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

// What this suite holds the pre-push hook to: that the coverage list a reader trusts and the segments the
// script actually runs are the same list, and that a segment labelled a hard failure can really refuse a
// push.
//
// Both rules have already been broken once in this file. The header listed four checks while the script
// ran seven (5, 6 and 7 existed only in the script), so a reader deciding what a push verifies was reading
// a stale contract. And a segment that only warns while claiming to be a gate looks identical to a working
// gate: it passes, prints a ✓, and lets the thing it names through.
//
// The scans are floored: a pattern that stopped matching must fail instead of reporting "no mismatch".

const hookPath = fileURLToPath(new URL('./pre-push-checks.sh', import.meta.url))
const text = readFileSync(hookPath, 'utf8')
const lines = text.split('\n')

/** Header list entries: `#   3. CHANGELOG has an entry …` (continuation lines carry no number). */
const DECLARED = /^#\s+(\d+)\.\s+(\S.*)$/
/** Segment markers: `# ---------- 3. CHANGELOG entry (hard fail) ----------`. */
const SEGMENT = /^# -{10} (\d+)\. (.+?) -{10}$/gm

/** Below this the walk is not looking at the hook any more; the count is the self-check. */
const MIN_SEGMENTS = 8
const MIN_TEXT = 3500

type Entry = { number: number; text: string }

const header = ((): string[] => {
  const stop = lines.findIndex((line) => line.startsWith('set -uo pipefail'))
  // Outside a test body: throw rather than assert, so a moved marker fails the file loudly.
  if (stop <= 10) throw new Error('pre-push hook: could not find the end of the header comment')
  return lines.slice(0, stop)
})()

const declared: Entry[] = header.flatMap((line) => {
  const match = DECLARED.exec(line)
  return match ? [{ number: Number(match[1]), text: match[2].trim() }] : []
})

const segments: (Entry & { title: string; body: string })[] = []
for (const match of text.matchAll(SEGMENT)) {
  const start = match.index ?? 0
  const next = text.indexOf('# ----------', start + match[0].length)
  segments.push({
    number: Number(match[1]),
    text: match[2],
    title: match[2].trim(),
    body: text.slice(start, next === -1 ? text.length : next)
  })
}

describe('pre-push hook self-evidence', () => {
  it('lists exactly the segments it runs, so the header cannot describe a weaker or stronger push', () => {
    expect(text.length).toBeGreaterThan(MIN_TEXT)
    expect(segments.length).toBeGreaterThanOrEqual(MIN_SEGMENTS)
    expect(declared.length).toBe(segments.length)

    const numbering = Array.from({ length: segments.length }, (_, index) => index + 1)
    expect(declared.map((entry) => entry.number)).toEqual(numbering)
    expect(segments.map((entry) => entry.number)).toEqual(numbering)

    for (const entry of [...declared, ...segments]) expect(entry.text).not.toBe('')
  })

  it('labels every segment as a hard failure or a soft reminder, with nothing in between', () => {
    const qualifiers = segments.map((segment) => /\((hard fail|soft)\)$/.exec(segment.text)?.[1])
    expect(qualifiers).not.toContain(undefined)
    expect(new Set(qualifiers)).toEqual(new Set(['hard fail', 'soft']))
  })

  it('makes every segment that claims to be a hard failure able to refuse the push', () => {
    const soft = segments.filter((segment) => segment.text.endsWith('(soft)'))
    const hard = segments.filter((segment) => segment.text.endsWith('(hard fail)'))
    expect(hard.length).toBeGreaterThanOrEqual(6)

    for (const segment of hard) {
      // The summary turns `FAIL=1` into the non-zero exit; without it the segment is decoration.
      expect(segment.body, `${segment.title} does not set FAIL`).toContain('FAIL=1')
    }
    for (const segment of soft) {
      expect(segment.body, `${segment.title} claims to be soft but sets FAIL`).not.toContain(
        'FAIL=1'
      )
      expect(segment.body).toContain('WARN=1')
    }
  })
})
