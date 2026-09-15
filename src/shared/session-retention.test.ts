import { describe, expect, it } from 'vitest'

import { MAX_RETAINED_SESSION_MESSAGES, trimSessionHistory } from './session-retention'

const messages = (count: number): { id: string; createdAt: number }[] =>
  Array.from({ length: count }, (_, index) => ({ id: `m${index + 1}`, createdAt: 1_000 + index }))

describe('session retention', () => {
  it('leaves a history at or under the limit untouched, and records nothing', () => {
    const atLimit = messages(10)
    const result = trimSessionHistory(atLimit, 10)

    expect(result.messages).toEqual(atLimit)
    expect(result.retention).toBeUndefined()
    expect(trimSessionHistory([], 10).retention).toBeUndefined()
  })

  it('keeps the newest messages and reports exactly what it dropped', () => {
    const result = trimSessionHistory(messages(12), 10)

    expect(result.messages).toHaveLength(10)
    // Newest kept: the conversation continues from where the reader left off.
    expect(result.messages[result.messages.length - 1].id).toBe('m12')
    expect(result.messages[0].id).toBe('m3')
    // The drop is datable, so a reader can tell where the record resumes.
    expect(result.retention).toEqual({ droppedMessages: 2, droppedBefore: 1_002 })
  })

  // The bound is the whole point: a session that runs for years must not be able to grow past it.
  it('bounds a very long history to the shipped default', () => {
    const result = trimSessionHistory(messages(MAX_RETAINED_SESSION_MESSAGES + 250))

    expect(result.messages).toHaveLength(MAX_RETAINED_SESSION_MESSAGES)
    expect(result.retention?.droppedMessages).toBe(250)
  })

  it('never mutates the input and returns a copy to write', () => {
    const source = messages(3)
    const result = trimSessionHistory(source, 3)

    expect(result.messages).not.toBe(source)
    expect(source).toHaveLength(3)
  })

  // A limit of zero would otherwise look like "deduce everything", which is never what a caller means.
  it('treats a non-positive limit as "do not trim"', () => {
    const source = messages(3)

    expect(trimSessionHistory(source, 0).messages).toHaveLength(3)
    expect(trimSessionHistory(source, 0).retention).toBeUndefined()
  })
})
