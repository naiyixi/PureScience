import { describe, expect, it } from 'vitest'

import {
  getProjectDbClient,
  isProjectDbReleased,
  ProjectDbReleasedError,
  releaseProjectDbForShutdown
} from './prisma-client'

// Kept in its own file: the release latches process-wide state, so mixing it with the client tests would
// leak the latch into unrelated cases.
describe('project database release for shutdown (v2.0.0 P0-1)', () => {
  it('names "no-client" when nothing ever opened the database', async () => {
    expect(await releaseProjectDbForShutdown()).toEqual({ released: true, reason: 'no-client' })
    expect(isProjectDbReleased()).toBe(true)
  })

  it('refuses a later read by name instead of reopening the query engine', async () => {
    await releaseProjectDbForShutdown()

    await expect(getProjectDbClient('/tmp/purescience-released-root')).rejects.toBeInstanceOf(
      ProjectDbReleasedError
    )
    await expect(getProjectDbClient('/tmp/purescience-released-root')).rejects.toThrow(
      'released for application shutdown'
    )
  })
})
