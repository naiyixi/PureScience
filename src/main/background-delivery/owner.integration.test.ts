// The delivery owner against a real database and a real session file on disk.
//
// The interesting cases are the ones a single process cannot normally produce: a worker that died after
// writing the turn but before marking the delivery consumed, and a session that cannot be read. Both are
// driven here by calling the repository directly to set up the state, then letting the owner drain it.

import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  NEUTRAL_BACKGROUND_DELIVERY_LABELS,
  type BackgroundDeliveryLabels
} from '../../shared/background-delivery'
import { backgroundDeliveryLabelsFor } from '../../shared/background-delivery-labels'
import type { PersistedChatSession } from '../../shared/session-persistence'
import { disconnectProjectDbClient, getProjectDbClient } from '../projects/prisma-client'
import {
  BackgroundDeliveryOwner,
  findDeliveredMessage,
  type BackgroundDeliveryOwnerDeps
} from './owner'
import { BackgroundDeliveryRepository } from './repository'

let root: string

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'purescience-delivery-owner-'))
})

afterAll(async () => {
  await disconnectProjectDbClient().catch(() => undefined)
  await rm(root, { recursive: true, force: true })
})

const sessionFile = (sessionId: string): string =>
  join(root, 'sessions', 'project-a', `${sessionId}.json`)

const writeSession = async (sessionId: string, session: PersistedChatSession): Promise<void> => {
  await mkdir(join(root, 'sessions', 'project-a'), { recursive: true })
  const { writeFile } = await import('node:fs/promises')
  await writeFile(sessionFile(sessionId), JSON.stringify({ version: 2, session }), 'utf8')
}

const readSession = async (sessionId: string): Promise<PersistedChatSession> =>
  (
    JSON.parse(await readFile(sessionFile(sessionId), 'utf8')) as {
      session: PersistedChatSession
    }
  ).session

const seedSession = (
  sessionId: string,
  messages: PersistedChatSession['messages'] = []
): PersistedChatSession => ({
  id: sessionId,
  projectId: 'project-a',
  title: 'Background run',
  messages,
  activities: [],
  cwd: '/tmp',
  status: 'idle',
  createdAt: 1,
  updatedAt: 1
})

const owner = (
  overrides: {
    now?: () => number
    leaseMs?: number
    startTurn?: BackgroundDeliveryOwnerDeps['startTurn']
    labels?: BackgroundDeliveryOwnerDeps['labels']
  } = {}
): BackgroundDeliveryOwner => {
  const repo = new BackgroundDeliveryRepository(() => getProjectDbClient(root))
  return new BackgroundDeliveryOwner({
    deliveries: repo,
    sessions: {
      loadSession: async (_projectId, sessionId) => {
        try {
          return await readSession(sessionId)
        } catch {
          return undefined
        }
      },
      saveSession: async (session) => {
        await writeSession(session.id, session)
      }
    },
    labels: overrides.labels ?? NEUTRAL_BACKGROUND_DELIVERY_LABELS,
    startTurn: overrides.startTurn,
    now: overrides.now ?? (() => 1_000),
    leaseMs: overrides.leaseMs,
    newClaimToken: () => 'claim-token',
    newMessageId: () => `message-delivery-${Math.random().toString(36).slice(2, 8)}`
  })
}

describe('background delivery owner against a real database and session file', () => {
  it('writes the finished result into the session and closes the delivery', async () => {
    const sessionId = 'session-deliver'
    await writeSession(sessionId, seedSession(sessionId))
    const app = owner({ now: () => 10_000 })

    await app.registerJobResult({
      jobId: 'job-deliver',
      projectId: 'project-a',
      sessionId,
      outputFiles: ['hpc/job-deliver/featured/out.csv'],
      fingerprint: 'sha256:feedface'
    })

    const run = await app.deliverSession(sessionId)
    expect(run.drained).toBe(true)
    expect(run.delivered).toHaveLength(1)
    expect(run.blocked).toHaveLength(0)

    const session = await readSession(sessionId)
    expect(session.messages).toHaveLength(1)
    const message = session.messages[0]
    // The result is structured on the message, not only described in prose, so the UI can word it itself.
    expect(message.backgroundDelivery).toEqual({
      deliveryId: run.delivered[0].id,
      jobId: 'job-deliver',
      sourceKind: 'compute',
      outputFiles: ['hpc/job-deliver/featured/out.csv'],
      fingerprint: 'sha256:feedface',
      reason: undefined
    })
    expect(message.content).toContain('job-deliver')
    expect(message.content).toContain('sha256:feedface')
    // The delivery names the message it landed in, so the ledger and the session agree.
    expect(run.delivered[0].state).toBe('consumed')
    expect(run.delivered[0].continuationMessageId).toBe(message.id)

    // A second drain finds nothing to do: one result, one turn.
    const second = await app.deliverSession(sessionId)
    expect(second.delivered).toHaveLength(0)
    expect((await readSession(sessionId)).messages).toHaveLength(1)
  })

  it('delivers a result that could not be read as a missing result, not as an analysis', async () => {
    const sessionId = 'session-unreadable'
    await writeSession(sessionId, seedSession(sessionId))
    const repo = new BackgroundDeliveryRepository(() => getProjectDbClient(root))
    const app = owner({ now: () => 20_000 })

    await app.registerJobResult({
      jobId: 'job-unreadable',
      projectId: 'project-a',
      sessionId,
      outputFiles: [],
      fingerprint: undefined
    })
    // The job finished but produced nothing readable: the delivery is flagged, and the session is told why.
    const delivery = (await repo.findByJobId('job-unreadable'))!
    await repo.claim(delivery.id, { now: 20_000, claimToken: 'placeholder' })
    await repo.markNeedsAttention(delivery.id, 'result-unreadable', 20_000)

    const run = await app.deliverSession(sessionId)
    expect(run.delivered).toHaveLength(1)

    const session = await readSession(sessionId)
    expect(session.messages[0].backgroundDelivery?.reason).toBe('result-unreadable')
    expect(session.messages[0].content).toContain('No result was produced')
    expect(session.messages[0].content).not.toContain('sha256:')
  })

  it('does not write a second turn when a worker died after writing the first', async () => {
    const sessionId = 'session-restart'
    await writeSession(sessionId, seedSession(sessionId))
    const repo = new BackgroundDeliveryRepository(() => getProjectDbClient(root))
    const app = owner({ now: () => 30_000, leaseMs: 1_000 })

    await app.registerJobResult({
      jobId: 'job-restart',
      projectId: 'project-a',
      sessionId,
      outputFiles: ['hpc/out.csv'],
      fingerprint: 'sha256:restart'
    })
    const delivery = (await repo.findByJobId('job-restart'))!

    // A worker claims the delivery and writes the turn, then dies before marking it consumed.
    await repo.claim(delivery.id, { now: 30_000, leaseMs: 1_000, claimToken: 'doomed' })
    await repo.markDispatching(delivery.id, 'doomed', 30_100)
    const written = seedSession(sessionId, [
      {
        id: 'message-written-before-crash',
        role: 'user',
        content: 'A background job has finished.',
        status: 'complete',
        eventIds: [],
        createdAt: 30_100,
        updatedAt: 30_100,
        backgroundDelivery: {
          deliveryId: delivery.id,
          jobId: 'job-restart',
          sourceKind: 'compute',
          outputFiles: ['hpc/out.csv'],
          fingerprint: 'sha256:restart',
          reason: undefined
        }
      }
    ])
    await writeSession(sessionId, written)

    // The next run takes the work over once the dead worker's lease is up...
    const takeover = owner({ now: () => 31_500, leaseMs: 1_000 })
    const run = await takeover.deliverSession(sessionId)
    expect(run.delivered).toHaveLength(1)

    // ...and adopts the turn that is already there instead of writing a duplicate.
    const session = await readSession(sessionId)
    expect(session.messages).toHaveLength(1)
    expect(findDeliveredMessage(session, delivery.id)?.id).toBe('message-written-before-crash')
    const after = (await repo.findById(delivery.id))!
    expect(after.state).toBe('consumed')
    expect(after.continuationMessageId).toBe('message-written-before-crash')
  })

  it('flags a result whose session cannot be read instead of losing it', async () => {
    const app = owner({ now: () => 40_000 })

    await app.registerJobResult({
      jobId: 'job-no-session',
      projectId: 'project-a',
      sessionId: 'session-missing',
      outputFiles: ['hpc/out.csv'],
      fingerprint: 'sha256:orphan'
    })

    const run = await app.deliverSession('session-missing')
    expect(run.delivered).toHaveLength(0)
    expect(run.blocked).toHaveLength(1)
    expect(run.blocked[0].reason).toBe('session-unavailable')

    // Named, not dropped: the delivery waits in needs-attention with its reason recorded.
    const repo = new BackgroundDeliveryRepository(() => getProjectDbClient(root))
    const flagged = (await repo.findByJobId('job-no-session'))!
    expect(flagged.state).toBe('needs-attention')
    expect(flagged.reason).toBe('session-unavailable')
    expect(flagged.continuationMessageId).toBeUndefined()

    // And it stays consumable, so once the session is readable again the result is not lost.
    await writeSession('session-missing', seedSession('session-missing'))
    const retry = await app.deliverSession('session-missing')
    expect(retry.delivered).toHaveLength(1)
    const delivered = await readSession('session-missing')
    expect(delivered.messages[0].backgroundDelivery?.jobId).toBe('job-no-session')
  })

  it('hands its claims back on a clean stop instead of sitting on them', async () => {
    const sessionId = 'session-release'
    await writeSession(sessionId, seedSession(sessionId))
    const repo = new BackgroundDeliveryRepository(() => getProjectDbClient(root))
    const app = owner({ now: () => 50_000 })

    await app.registerJobResult({
      jobId: 'job-release',
      projectId: 'project-a',
      sessionId,
      outputFiles: ['hpc/out.csv'],
      fingerprint: 'sha256:release'
    })
    const delivery = (await repo.findByJobId('job-release'))!
    await repo.claim(delivery.id, { now: 50_000, leaseMs: 60_000, claimToken: 'stopping' })

    await app.releaseSession(sessionId)

    const released = (await repo.findById(delivery.id))!
    expect(released.claimToken).toBeUndefined()
    expect(released.state).toBe('pending')
    // Immediately claimable again, with no wait for the lease to run out.
    const reclaimed = await repo.claim(delivery.id, { now: 50_001, claimToken: 'next' })
    expect(reclaimed.status).toBe('claimed')
  })

  it('starts one turn for the delivered results, and never a second one', async () => {
    const sessionId = 'session-turn'
    await writeSession(sessionId, seedSession(sessionId))
    const started: { sessionId: string; deliveryIds: readonly string[]; prompt: string }[] = []
    const app = owner({ now: () => 60_000, startTurn: async (input) => void started.push(input) })

    await app.registerJobResult({
      jobId: 'job-turn-1',
      projectId: 'project-a',
      sessionId,
      outputFiles: ['hpc/a.csv'],
      fingerprint: 'sha256:a'
    })
    await app.registerJobResult({
      jobId: 'job-turn-2',
      projectId: 'project-a',
      sessionId,
      outputFiles: ['hpc/b.csv'],
      fingerprint: 'sha256:b'
    })

    const run = await app.deliverSession(sessionId)
    expect(run.delivered).toHaveLength(2)
    expect(run.startedTurn).toBe(true)
    // Two results that arrived together are one piece of work, so they are one turn.
    expect(started).toHaveLength(1)
    expect(started[0].deliveryIds).toHaveLength(2)
    expect(started[0].prompt).toContain('job-turn-1')
    expect(started[0].prompt).toContain('job-turn-2')

    // Nothing left to deliver means nothing to start.
    const second = await app.deliverSession(sessionId)
    expect(second.startedTurn).toBe(false)
    expect(started).toHaveLength(1)
    expect((await readSession(sessionId)).messages).toHaveLength(2)
  })

  it('never starts a turn for a result that could not be read', async () => {
    const sessionId = 'session-turn-blocked'
    await writeSession(sessionId, seedSession(sessionId))
    const repo = new BackgroundDeliveryRepository(() => getProjectDbClient(root))
    const started: unknown[] = []
    const app = owner({ now: () => 70_000, startTurn: async (input) => void started.push(input) })

    await app.registerJobResult({
      jobId: 'job-turn-blocked',
      projectId: 'project-a',
      sessionId,
      outputFiles: ['hpc/out.csv'],
      fingerprint: 'sha256:blocked'
    })
    const delivery = (await repo.findByJobId('job-turn-blocked'))!
    await repo.claim(delivery.id, { now: 70_000, claimToken: 'flagging' })
    await repo.markNeedsAttention(delivery.id, 'result-unreadable', 70_000)

    const run = await app.deliverSession(sessionId)
    // The session is told there is no result; the agent is not asked to analyse one it never saw.
    expect(run.delivered).toHaveLength(1)
    expect(run.startedTurn).toBe(false)
    expect(started).toHaveLength(0)
    expect((await readSession(sessionId)).messages[0].content).toContain('No result was produced')
  })

  // The continuation is read long after it is written, in whatever language the window was showing at
  // the time — so the wording is resolved when the turn is written, not when the owner was built.
  it('writes the continuation in the language in force at delivery time', async () => {
    const repo = new BackgroundDeliveryRepository(() => getProjectDbClient(root))
    let labels: BackgroundDeliveryLabels = NEUTRAL_BACKGROUND_DELIVERY_LABELS
    const app = new BackgroundDeliveryOwner({
      deliveries: repo,
      sessions: {
        loadSession: async (_projectId, sessionId) => {
          try {
            return await readSession(sessionId)
          } catch {
            return undefined
          }
        },
        saveSession: async (session) => {
          await writeSession(session.id, session)
        }
      },
      labels: () => labels,
      now: () => 80_000,
      newClaimToken: () => 'claim-token-language',
      newMessageId: () => 'message-language'
    })

    const sessionId = 'session-language'
    await writeSession(sessionId, seedSession(sessionId))
    await repo.ensureForJob({
      projectId: 'project-a',
      sessionId,
      jobId: 'job-language',
      outputFiles: ['hpc/out.csv'],
      fingerprint: 'sha256:language',
      now: 79_000
    })
    // The reader switches the interface language between the owner being built and the result landing.
    labels = backgroundDeliveryLabelsFor('zh')
    await app.deliverSession(sessionId)

    const content = (await readSession(sessionId)).messages[0].content
    expect(content).toContain('后台作业已完成')
    expect(content).not.toContain('A background job has finished')
  })
})
