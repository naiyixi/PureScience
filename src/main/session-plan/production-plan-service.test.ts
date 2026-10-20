import { describe, expect, it, vi } from 'vitest'

import { createProductionPlanService } from './production-plan-service'
import { SessionRuntimeContextMissingError } from '../session-persistence/coordinator'

// The unit tests in plan-service.test.ts use a message-matching stand-in for "the Session is missing".
// That proves the branch, not the wiring: an import or identity mistake in production-plan-service.ts
// would keep every one of them green while the shipping app still rejected. This file builds the service
// the way the app builds it and throws the error the coordinator actually throws.
const createService = (
  readSessionRuntimeContext: () => Promise<never>
): ReturnType<typeof createProductionPlanService> =>
  createProductionPlanService({
    artifactTurns: { writeForActiveTurn: vi.fn() },
    provenance: { resolveVersionContent: vi.fn() },
    sessions: {
      readSessionRuntimeContext,
      patchSessionRuntimeContext: vi.fn(),
      appendUserMessageToInteraction: vi.fn()
    }
  })

describe('production Plan service wiring', () => {
  it('answers a missing Session with no Plan instead of rejecting', async () => {
    const service = createService(() =>
      Promise.reject(new SessionRuntimeContextMissingError('read'))
    )

    await expect(service.getProjection('project-1', 'session-1')).resolves.toBeNull()
  })

  it('still rejects an unreadable Session, proving the predicate is narrow', async () => {
    const service = createService(() =>
      Promise.reject(
        new Error('Cannot read Session runtime context because its durable JSON is unreadable.')
      )
    )

    await expect(service.getProjection('project-1', 'session-1')).rejects.toThrow(
      'its durable JSON is unreadable'
    )
  })
})
