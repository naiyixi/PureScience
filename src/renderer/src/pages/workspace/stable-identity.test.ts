import { describe, expect, it } from 'vitest'

import { sameElements, stableArray, stableValue } from './stable-identity'

describe('identity-preserving caches', () => {
  it('keeps the previous array when the rebuilt one holds the same instances', () => {
    const cache = new Map<string, number[] | undefined>()
    const first = stableArray(cache, 'message-1', [1, 2, 3])
    const second = stableArray(cache, 'message-1', [1, 2, 3])

    expect(second).toBe(first)
  })

  it('returns a fresh array when a member changed', () => {
    const cache = new Map<string, number[] | undefined>()
    const first = stableArray(cache, 'message-1', [1, 2])
    const second = stableArray(cache, 'message-1', [1, 2, 3])

    expect(second).not.toBe(first)
    expect(second).toEqual([1, 2, 3])
  })

  it('keys arrays per slot so one message does not affect another', () => {
    const cache = new Map<string, number[] | undefined>()
    const first = stableArray(cache, 'message-1', [1])
    const other = stableArray(cache, 'message-2', [1])

    expect(other).not.toBe(first)
  })

  it('keeps the previous value object when its fields are equal', () => {
    const cache = new Map<string, object>()
    const first = stableValue(cache, 'message-1', { backendId: 'a', model: 'b' })
    const second = stableValue(cache, 'message-1', { backendId: 'a', model: 'b' })

    expect(second).toBe(first)
  })

  it('returns a new value object when a field differs', () => {
    const cache = new Map<string, object>()
    const first = stableValue(cache, 'message-1', { backendId: 'a', model: 'b' })
    const second = stableValue(cache, 'message-1', { backendId: 'a', model: 'c' })

    expect(second).not.toBe(first)
    expect(second).toEqual({ backendId: 'a', model: 'c' })
  })

  it('does not confuse two different shapes that happen to have no fields', () => {
    class Segment {}
    class Synthesized {}
    const cache = new Map<string, object>()
    const segment = new Segment()
    const synthesized = new Synthesized()
    stableValue(cache, 'message-1', segment)

    // Different constructors always rebuild — a graph segment must never be passed off as a synthesized
    // runtime identity, even when neither carries enumerable fields.
    expect(stableValue(cache, 'message-1', synthesized)).not.toBe(segment)
  })

  it('compares dependency tuples element-wise', () => {
    const message = { id: 'message-1' }

    expect(sameElements([message, 1], [message, 1])).toBe(true)
    expect(sameElements([message, 1], [message, 2])).toBe(false)
    expect(sameElements([message], [message, 1])).toBe(false)
    expect(sameElements(undefined, [message])).toBe(false)
  })
})
