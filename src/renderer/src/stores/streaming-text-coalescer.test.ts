import { describe, expect, it, vi } from 'vitest'

import { createTextCoalescer } from './streaming-text-coalescer'

const createHarness = (flushMs = 50) => {
  const flushes: string[] = []
  const scheduled: { callback: () => void; delayMs: number }[] = []
  const coalescer = createTextCoalescer({
    flushMs,
    onFlush: (text) => flushes.push(text),
    schedule: (callback, delayMs) => {
      scheduled.push({ callback, delayMs })
      return scheduled.length
    },
    cancel: () => undefined
  })
  return { coalescer, flushes, scheduled }
}

describe('streamed text coalescing', () => {
  it('holds deltas for the window and hands on the whole text once', () => {
    const { coalescer, flushes, scheduled } = createHarness()

    coalescer.push('Hel')
    coalescer.push('lo ')
    coalescer.push('world')

    expect(flushes).toEqual([])
    expect(scheduled).toHaveLength(1)
    scheduled[0]!.callback()
    // One render's worth of text, not three fragments: the message is never shown half-built.
    expect(flushes).toEqual(['Hello world'])
  })

  it('never loses or reorders a character', () => {
    const { coalescer, flushes, scheduled } = createHarness()
    const deltas = ['a', 'b', 'c', 'd', 'e']

    for (const delta of deltas) coalescer.push(delta)
    scheduled[0]!.callback()

    expect(flushes.join('')).toBe(deltas.join(''))
  })

  it('starts a fresh window after a flush', () => {
    const { coalescer, flushes, scheduled } = createHarness()

    coalescer.push('one')
    scheduled[0]!.callback()
    coalescer.push('two')

    expect(scheduled).toHaveLength(2)
    scheduled[1]!.callback()
    expect(flushes).toEqual(['one', 'two'])
  })

  it('flushes immediately on demand and cancels the window', () => {
    const { coalescer, flushes } = createHarness()

    coalescer.push('final text')
    coalescer.flushNow()

    expect(flushes).toEqual(['final text'])
    expect(coalescer.pending()).toBe('')
  })

  it('does not emit twice for the same batch', () => {
    const { coalescer, flushes, scheduled } = createHarness()

    coalescer.push('done')
    coalescer.flushNow()
    // A timer that was already scheduled must not deliver the same text a second time.
    scheduled[0]?.callback()

    expect(flushes).toEqual(['done'])
  })

  it('emits nothing when there is nothing pending', () => {
    const { coalescer, flushes } = createHarness()

    coalescer.flushNow()

    expect(flushes).toEqual([])
  })

  it('keeps a delta pushed during a flush for the next window', () => {
    const reentrant = createHarness()
    const coalescer = createTextCoalescer({
      flushMs: 50,
      onFlush: (text) => {
        reentrant.flushes.push(text)
        if (text === 'first') coalescer.push('second')
      },
      schedule: (callback) => {
        reentrant.scheduled.push({ callback, delayMs: 50 })
        return reentrant.scheduled.length
      },
      cancel: () => undefined
    })

    coalescer.push('first')
    reentrant.scheduled[0]!.callback()
    reentrant.scheduled[1]!.callback()

    expect(reentrant.flushes).toEqual(['first', 'second'])
  })

  it('uses the configured window length', () => {
    const schedule = vi.fn(() => 1)
    const coalescer = createTextCoalescer({ flushMs: 50, onFlush: vi.fn(), schedule })

    coalescer.push('x')

    expect(schedule).toHaveBeenCalledWith(expect.any(Function), 50)
  })
})
