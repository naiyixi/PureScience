import { describe, expect, it, vi } from 'vitest'

import { deliverComputeResult, recoverComputeResults } from './compute-source'
import type { BackgroundDeliveryOwner, BackgroundDeliveryRun } from './owner'
import {
  BACKGROUND_DELIVERY_SCHEMA_VERSION,
  type BackgroundDelivery
} from '../../shared/background-delivery'

type Owner = Pick<BackgroundDeliveryOwner, 'registerJobResult' | 'deliverSession'>

const emptyRun: BackgroundDeliveryRun = {
  delivered: [],
  blocked: [],
  drained: true,
  startedTurn: false
}

// A ledger stand-in that records the order of the two calls that matter here: registration and drain.
const fakeOwner = (overrides: Partial<Owner> = {}): { owner: Owner; calls: string[] } => {
  const calls: string[] = []
  const owner: Owner = {
    registerJobResult: async (input): Promise<BackgroundDelivery> => {
      calls.push(`register:${input.jobId}`)
      return {
        schemaVersion: BACKGROUND_DELIVERY_SCHEMA_VERSION,
        id: `delivery-${input.jobId}`,
        projectId: input.projectId,
        sessionId: input.sessionId,
        jobId: input.jobId,
        sourceKind: 'compute',
        state: 'waiting-result',
        outputFiles: [],
        fingerprint: undefined,
        claimToken: undefined,
        claimExpiresAt: undefined,
        continuationMessageId: undefined,
        reason: undefined,
        createdAt: 0,
        updatedAt: 0,
        consumedAt: undefined
      }
    },
    deliverSession: async (sessionId): Promise<BackgroundDeliveryRun> => {
      calls.push(`drain:${sessionId}`)
      return emptyRun
    },
    ...overrides
  }
  return { owner, calls }
}

const job = (
  id: string,
  sessionId: string
): { job_id: string; project_id: string; session_id: string } => ({
  job_id: id,
  project_id: 'project-1',
  session_id: sessionId
})

describe('background delivery: compute source', () => {
  it('registers the finished job before draining its session', async () => {
    const { owner, calls } = fakeOwner()

    await deliverComputeResult(job('j1', 's1'), { owner })

    expect(calls).toEqual(['register:j1', 'drain:s1'])
  })

  it('registers a whole batch before draining, and drains each session once', async () => {
    const { owner, calls } = fakeOwner()

    const outcome = await recoverComputeResults(
      [job('j1', 's1'), job('j2', 's1'), job('j3', 's2')],
      { owner }
    )

    // One drain per session, after every result is in the ledger: three results of one session are one
    // piece of work, and a turn per result would pay for three analyses of the same batch.
    expect(calls).toEqual(['register:j1', 'register:j2', 'register:j3', 'drain:s1', 'drain:s2'])
    expect(outcome).toEqual({ registered: 3, sessions: 2, failed: 0 })
  })

  it('reports a registration failure, keeps the rest, and never throws', async () => {
    const failing = fakeOwner()
    const onError = vi.fn()
    const owner: Owner = {
      ...failing.owner,
      registerJobResult: async (input) => {
        if (input.jobId === 'j2') throw new Error('ledger unavailable')
        return failing.owner.registerJobResult(input)
      }
    }

    const outcome = await recoverComputeResults(
      [job('j1', 's1'), job('j2', 's2'), job('j3', 's3')],
      {
        owner,
        onError
      }
    )

    expect(outcome).toEqual({ registered: 2, sessions: 2, failed: 1 })
    expect(onError).toHaveBeenCalledWith(expect.any(Error), { jobId: 'j2', sessionId: 's2' })
    // The session whose only job failed to register is not drained: there is nothing in the ledger to
    // claim, and a drain would report a success that did not happen.
    expect(failing.calls).toEqual(['register:j1', 'register:j3', 'drain:s1', 'drain:s3'])
  })

  it('reports a drain failure instead of failing the whole recovery', async () => {
    const onError = vi.fn()
    const { owner } = fakeOwner({
      deliverSession: async () => {
        throw new Error('session unreadable')
      }
    })

    const outcome = await recoverComputeResults([job('j1', 's1'), job('j2', 's2')], {
      owner,
      onError
    })

    expect(outcome).toEqual({ registered: 2, sessions: 2, failed: 2 })
    expect(onError).toHaveBeenCalledTimes(2)
    expect(onError).toHaveBeenCalledWith(expect.any(Error), { sessionId: 's1' })
  })
})
