import { describe, expect, it } from 'vitest'

import { createLoopHeldWindows } from './loop-held-windows'

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
