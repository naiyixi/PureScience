import { describe, expect, it } from 'vitest'

import {
  createLoopHeldWindows,
  heldSplitFields,
  heldSplitForMonotonicWindow,
  heldSplitForWallWindow,
  heldSplitFromMeasured,
  toMonotonicWindow,
  type LoopHeldWindows
} from './loop-held-windows'

// These windows exist to split a wall duration into "the process was running" and "it was not". Everything
// here is about never inventing held time: a held reading that overstates turns our own slow path into
// somebody else's problem, which is exactly the misreading the split is meant to stop.
describe('loop held windows', () => {
  it('returns only the part of a duration that fell inside a recorded window', () => {
    const held = createLoopHeldWindows()
    held.record(1_000, 21_700)

    // A handler that started before the window and ended inside it.
    expect(held.heldMsWithin(500, 21_000)).toBe(20_000)
    // One that started inside it and ended after it.
    expect(held.heldMsWithin(21_000, 25_000)).toBe(700)
    // One that spans it entirely: clipped to the span asked about, never the whole window.
    expect(held.heldMsWithin(500, 3_000)).toBe(2_000)
    // One that missed it completely.
    expect(held.heldMsWithin(30_000, 31_000)).toBe(0)
  })

  it('sums several windows without ever exceeding the span it was asked about', () => {
    const held = createLoopHeldWindows()
    held.record(1_000, 3_000)
    held.record(4_000, 6_000)
    // Windows [1 000, 3 000] and [4 000, 6 000] inside [500, 5 500]: 2 000 + the 1 500 of the second window
    // that the query still covers. Summed, not slotted: the answer is what the process lost, not a shape.
    expect(held.heldMsWithin(500, 5_500)).toBe(3_500)
    // [2 500, 4 500] catches the tail of the first window (500 ms) and the head of the second (500 ms).
    expect(held.heldMsWithin(2_500, 4_500)).toBe(1_000)
  })

  it('ignores windows shorter than the floor, so scheduler jitter cannot read as held time', () => {
    const held = createLoopHeldWindows({ minimumMs: 500 })
    held.record(1_000, 1_100)
    expect(held.heldMsWithin(900, 1_200)).toBe(0)

    held.record(2_000, 2_600)
    expect(held.heldMsWithin(1_900, 2_700)).toBe(600)
  })

  it('keeps the newest windows and forgets the oldest once the ring is full', () => {
    const held = createLoopHeldWindows({ capacity: 2, minimumMs: 0 })
    held.record(0, 1_000)
    held.record(2_000, 3_000)
    held.record(4_000, 5_000)

    expect(held.heldMsWithin(0, 1_000)).toBe(0)
    expect(held.heldMsWithin(2_000, 3_000)).toBe(1_000)
    expect(held.heldMsWithin(4_000, 5_000)).toBe(1_000)
  })

  it('answers zero for a nonsensical span instead of a negative or NaN held time', () => {
    const held = createLoopHeldWindows()
    held.record(1_000, 2_000)
    expect(held.heldMsWithin(2_000, 2_000)).toBe(0)
    expect(held.heldMsWithin(2_000, 1_000)).toBe(0)
    expect(held.heldMsWithin(Number.NaN, 2_000)).toBe(0)
    // Recording a broken window is a no-op rather than a window at epoch zero.
    held.record(Number.NaN, 5_000)
    expect(held.heldMsWithin(0, 10_000)).toBe(1_000)
  })
})

// Timers that measure with `Date.now()` cannot read the windows above directly, and moving them (and the
// tests that fake `Date`) onto a second clock would be a much larger change than the split is worth. The
// conversion is checked here because it is the only place the two clock domains are tied together.
describe('wall-clock windows read against the loop-held ring', () => {
  it('places a wall window in the monotonic domain using a pair read at its end', () => {
    // Window [1 000, 3 000] on the wall clock; the pair was read at the window's end (wall 3 000 = perf 50 000).
    expect(toMonotonicWindow(1_000, 3_000, { wallMs: 3_000, perfMs: 50_000 })).toEqual({
      startMs: 48_000,
      endMs: 50_000
    })
    // A wall-clock value that cannot describe a window yields nothing rather than a shifted guess.
    expect(toMonotonicWindow(3_000, 1_000, { wallMs: 3_000, perfMs: 50_000 })).toBeUndefined()
    expect(toMonotonicWindow(Number.NaN, 3_000, { wallMs: 3_000, perfMs: 50_000 })).toBeUndefined()
    expect(toMonotonicWindow(1_000, 3_000, { wallMs: 3_000, perfMs: Number.NaN })).toBeUndefined()
  })

  it('splits a wall-clock duration by the part that fell inside a held window', () => {
    const held = createLoopHeldWindows({ minimumMs: 0 })
    // Half of the handler's 2 000 ms window sat inside one 900 ms held period plus a 100 ms one.
    held.record(48_500, 49_400)
    held.record(49_600, 49_700)

    const split = heldSplitForWallWindow(1_000, 2_000, {
      source: held,
      pair: { wallMs: 3_000, perfMs: 50_000 }
    })
    expect(split).toEqual({ heldMs: 1_000, ownMs: 1_000 })
  })

  it('says nothing when the loop was free, so a zero is never mistaken for a measurement', () => {
    const held = createLoopHeldWindows()
    const options = { source: held, pair: { wallMs: 3_000, perfMs: 50_000 } }
    expect(heldSplitForWallWindow(1_000, 2_000, options)).toBeUndefined()
    // The spread used by call sites therefore contributes no field at all.
    expect(heldSplitFields(1_000, 2_000, options)).toEqual({})
    // A window that never happened is not evidence either.
    expect(heldSplitForWallWindow(1_000, 0, options)).toBeUndefined()
    expect(heldSplitForWallWindow(1_000, Number.NaN, options)).toBeUndefined()
  })

  it('never splits into more held time than the window contains', () => {
    const held = createLoopHeldWindows({ minimumMs: 0 })
    // A held period far longer than the handler's own window.
    held.record(40_000, 60_000)

    const split = heldSplitForWallWindow(1_000, 700, {
      source: held,
      pair: { wallMs: 1_700, perfMs: 55_000 }
    })
    expect(split).toEqual({ heldMs: 700, ownMs: 0 })
    // Fractional readings are rounded, not truncated toward a friendlier story.
    const fractional = createLoopHeldWindows({ minimumMs: 0 })
    fractional.record(48_480, 48_980.4)
    expect(
      heldSplitForWallWindow(1_000, 2_000, {
        source: fractional,
        pair: { wallMs: 3_000, perfMs: 50_000 }
      })
    ).toEqual({ heldMs: 500, ownMs: 1_500 })
  })
})

// The arithmetic both consumer families share. It is one function rather than a line copied into each call site
// because "how much of this was ours" must have exactly one answer; these cases pin the invariants a copy would
// have drifted away from silently.
describe('the shared split arithmetic', () => {
  it('partitions the window and never reports more held time than it contains', () => {
    expect(heldSplitFromMeasured(300, 1_000)).toEqual({ heldMs: 300, ownMs: 700 })
    // A ring cannot hand out more than the span asked about, but the function does not depend on that: a
    // caller passing a held figure larger than its window gets the window, not a negative remainder.
    expect(heldSplitFromMeasured(5_000, 700)).toEqual({ heldMs: 700, ownMs: 0 })
  })

  it('rounds both halves rather than truncating toward a friendlier story', () => {
    expect(heldSplitFromMeasured(0.6, 10.4)).toEqual({ heldMs: 1, ownMs: 9 })
  })

  it('says nothing when there is no window or no reading to split', () => {
    // No held time and sub-millisecond held time are the same answer: nothing to split. Printing `heldMs: 0`
    // would read as a measurement and the line would say "the loop was free" when nobody watched it.
    expect(heldSplitFromMeasured(0, 700)).toBeUndefined()
    expect(heldSplitFromMeasured(0.4, 100)).toBeUndefined()
    expect(heldSplitFromMeasured(10, 0)).toBeUndefined()
    expect(heldSplitFromMeasured(10, Number.NaN)).toBeUndefined()
    expect(heldSplitFromMeasured(Number.NaN, 100)).toBeUndefined()
  })

  // Three adapters (the IPC rejection floor, the application command router, and now the compose/session/
  // settings slow lines) measure on `performance.now()` and used to clip-and-round the same arithmetic at
  // their own call site. The helper is that arithmetic once; these cases pin the invariants a copy drifts from.
  it('splits a window measured on the monotonic clock, from its own start and end', () => {
    const held = createLoopHeldWindows({ minimumMs: 0 })
    held.record(1_000, 1_600)

    expect(heldSplitForMonotonicWindow(900, 2_000, 1_100, held)).toEqual({
      heldMs: 600,
      ownMs: 500
    })
    // A window that missed every recorded stall prints nothing at all, rather than `heldMs: 0`.
    expect(heldSplitForMonotonicWindow(5_000, 5_700, 700, held)).toBeUndefined()
    // The split never hands out more held time than the reading it is cutting up.
    expect(heldSplitForMonotonicWindow(1_000, 1_600, 200, held)).toEqual({ heldMs: 200, ownMs: 0 })
    // Unusable inputs stay silent instead of producing a made-up split.
    expect(heldSplitForMonotonicWindow(Number.NaN, 2_000, 1_100, held)).toBeUndefined()
    expect(heldSplitForMonotonicWindow(900, 900, 0, held)).toBeUndefined()
  })
})

// The ring is bounded, so on a machine that stalls often it drops its oldest windows and `heldMsWithin` then
// answers less than the truth — including zero, and zero is what every slow line prints as "the loop was free".
// These cases pin the third answer that keeps a dropped window from reading as a quiet process.
describe('what the ring no longer covers', () => {
  // capacity 2 with three stalls: the oldest ([0, 1 000]) is dropped, so coverage is complete from its end on.
  const overfull = (): LoopHeldWindows => {
    const held = createLoopHeldWindows({ capacity: 2, minimumMs: 0 })
    held.record(0, 1_000)
    held.record(2_000, 3_000)
    held.record(4_000, 5_000)
    return held
  }

  it('reports where its coverage starts once a window has been dropped', () => {
    // Nothing dropped yet: coverage reaches back to the first recorded window, so there is nothing to declare.
    expect(createLoopHeldWindows({ capacity: 2, minimumMs: 0 }).coverageStartMs()).toBeUndefined()
    expect(overfull().coverageStartMs()).toBe(1_000)
  })

  it('names the gap for a span that starts before that boundary', () => {
    const held = overfull()
    // The dropped window is exactly the one that covered this span: answering 0 here would be a lie.
    expect(heldSplitForMonotonicWindow(0, 1_000, 1_000, held)).toEqual({
      heldUnmeasured: 'windows-dropped'
    })
    // Straddling the boundary: part of it may sit inside the window that was dropped.
    expect(heldSplitForMonotonicWindow(500, 4_500, 4_000, held)).toEqual({
      heldUnmeasured: 'windows-dropped'
    })
  })

  it('still splits a span the retained windows answer for', () => {
    const held = overfull()
    // Starts where the dropped window ended, so nothing dropped can have covered it: 1 000 + 500 kept.
    expect(heldSplitForMonotonicWindow(1_000, 4_500, 3_500, held)).toEqual({
      heldMs: 1_500,
      ownMs: 2_000
    })
    // A covered span that missed both kept windows says nothing at all, rather than zero.
    expect(heldSplitForMonotonicWindow(5_500, 6_000, 500, held)).toBeUndefined()
  })

  it('carries the marker through the wall-clock bridge', () => {
    const held = createLoopHeldWindows({ capacity: 1, minimumMs: 0 })
    held.record(0, 1_000)
    held.record(2_000, 3_000)
    held.record(4_000, 5_000)
    expect(held.coverageStartMs()).toBe(3_000)

    const options = { source: held, pair: { wallMs: 3_000, perfMs: 5_000 } }
    // Wall [500, 3 500] → perf [2 500, 5 500]: starts before the boundary.
    expect(heldSplitFields(500, 3_000, options)).toEqual({ heldUnmeasured: 'windows-dropped' })
    // Wall [1 000, 3 000] → perf [3 000, 5 000]: from the boundary on, so the kept window answers 1 000 ms.
    expect(heldSplitFields(1_000, 2_000, options)).toEqual({ heldMs: 1_000, ownMs: 1_000 })
  })
})
