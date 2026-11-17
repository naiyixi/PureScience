import { describe, expect, it } from 'vitest'

import {
  notebookExecutionTimeoutMessage,
  notebookStartupGraceMessage
} from './kernel-timeout-message'

describe('notebook timeout messages', () => {
  it('names the budget, the interrupt that was already tried, and what to change', () => {
    const message = notebookExecutionTimeoutMessage(120_000)

    expect(message).toContain('120000ms')
    expect(message).toContain('soft interrupt was sent first')
    expect(message).toContain('kernel was dropped')
    expect(message).toContain('Split the cell')
  })

  it('separates "never started" from "ran too long"', () => {
    const message = notebookStartupGraceMessage()

    expect(message).toContain('never began executing')
    expect(message).toContain('startup grace expired')
    expect(message).not.toContain('timed out after')
  })
})
