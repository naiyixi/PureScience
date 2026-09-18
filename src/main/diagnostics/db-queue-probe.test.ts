import { describe, expect, it } from 'vitest'

import { startDbCanary } from './db-queue-probe'

describe('db canary', () => {
  it('times a trivial query', async () => {
    const fast = await startDbCanary(async () => undefined)
    expect(fast).toBeGreaterThanOrEqual(0)

    const slow = await startDbCanary(() => new Promise((resolve) => setTimeout(resolve, 60)))
    expect(slow).toBeGreaterThanOrEqual(50)
  })

  it('reports unknown rather than a number when the canary query fails', async () => {
    // A failed canary says nothing about engine load, so it must not read as "0 ms means the engine is clear".
    const failed = await startDbCanary(async () => {
      throw new Error('engine unavailable')
    })
    expect(failed).toBe(-1)
  })
})
