// Real SQLite, no mocks: the delivery ledger's promises are about what happens when a worker dies
// mid-delivery, so the tests that matter are the ones that let a lease expire and then try to take the
// work over. Runs against a temporary data root and never touches the user's data.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { disconnectProjectDbClient, getProjectDbClient } from '../projects/prisma-client'
import { BackgroundDeliveryRepository } from './repository'

let root: string

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'purescience-delivery-integration-'))
})

afterAll(async () => {
  await disconnectProjectDbClient().catch(() => undefined)
  await rm(root, { recursive: true, force: true })
})

const repository = (): BackgroundDeliveryRepository =>
  new BackgroundDeliveryRepository(() => getProjectDbClient(root))

const ensure = async (
  jobId: string,
  overrides: Partial<Parameters<BackgroundDeliveryRepository['ensureForJob']>[0]> = {}
): Promise<void> => {
  await repository().ensureForJob({
    jobId,
    projectId: 'project-a',
    sessionId: 'session-a',
    outputFiles: ['hpc/out.csv'],
    fingerprint: 'sha256:aaa',
    now: 1_000,
    ...overrides
  })
}

describe('background delivery ledger against a real database', () => {
  it('keeps a job with no result out of reach until its result exists', async () => {
    const repo = repository()
    const waiting = await repo.ensureForJob({
      jobId: 'job-waiting',
      projectId: 'project-a',
      sessionId: 'session-a',
      now: 1_000
    })
    expect(waiting.state).toBe('waiting-result')

    // Nothing to deliver yet, so a worker cannot take it.
    const early = await repo.claim(waiting.id, { now: 1_000 })
    expect(early).toEqual({ status: 'rejected', reason: 'not-consumable' })

    const ready = await repo.ensureForJob({
      jobId: 'job-waiting',
      projectId: 'project-a',
      sessionId: 'session-a',
      outputFiles: ['hpc/out.csv'],
      fingerprint: 'sha256:aaa',
      now: 2_000
    })
    expect(ready.id).toBe(waiting.id)
    expect(ready.state).toBe('pending')
    expect(ready.outputFiles).toEqual(['hpc/out.csv'])

    const claimed = await repo.claim(ready.id, { now: 2_000, claimToken: 'token-1' })
    expect(claimed.status).toBe('claimed')
  })

  it('will not hand the same delivery to two workers', async () => {
    const repo = repository()
    await ensure('job-race')
    const delivery = (await repo.findByJobId('job-race'))!

    const first = await repo.claim(delivery.id, { now: 10_000, claimToken: 'token-a' })
    const second = await repo.claim(delivery.id, { now: 10_001, claimToken: 'token-b' })

    expect(first.status).toBe('claimed')
    expect(second).toEqual({ status: 'rejected', reason: 'claim-held' })
    // The loser changed nothing: the holder's token is still the one on the row.
    const after = (await repo.findById(delivery.id))!
    expect(after.claimToken).toBe('token-a')
  })

  it('takes over a delivery whose worker died mid-flight, and fences the dead worker', async () => {
    const repo = repository()
    await ensure('job-crash')
    const delivery = (await repo.findByJobId('job-crash'))!

    const dead = await repo.claim(delivery.id, { now: 20_000, leaseMs: 1_000, claimToken: 'dead' })
    expect(dead.status).toBe('claimed')

    // Before the lease runs out the work is still the dead worker's.
    const tooEarly = await repo.claim(delivery.id, { now: 20_500, claimToken: 'successor' })
    expect(tooEarly).toEqual({ status: 'rejected', reason: 'claim-held' })

    // After it expires the work is nobody's, so it can be taken over instead of being stranded.
    const takeover = await repo.claim(delivery.id, { now: 21_001, claimToken: 'successor' })
    expect(takeover.status).toBe('claimed')
    expect(takeover.status === 'claimed' && takeover.claimToken).toBe('successor')

    // And the dead worker cannot come back and write: its token no longer matches.
    expect(await repo.markDispatching(delivery.id, 'dead', 21_100)).toBe(false)
    expect(await repo.markConsumed(delivery.id, 'dead', 'message-x', 21_100)).toBe(false)
    const after = (await repo.findById(delivery.id))!
    expect(after.state).toBe('claimed')
    expect(after.claimToken).toBe('successor')
  })

  it('consumes exactly once and then stays closed', async () => {
    const repo = repository()
    await ensure('job-once')
    const delivery = (await repo.findByJobId('job-once'))!

    const claimed = await repo.claim(delivery.id, { now: 30_000, claimToken: 'holder' })
    expect(claimed.status).toBe('claimed')
    expect(await repo.markDispatching(delivery.id, 'holder', 30_100)).toBe(true)

    expect(await repo.markConsumed(delivery.id, 'holder', 'message-1', 30_200)).toBe(true)
    const consumed = (await repo.findById(delivery.id))!
    expect(consumed.state).toBe('consumed')
    expect(consumed.continuationMessageId).toBe('message-1')
    expect(consumed.consumedAt).toBe(30_200)
    expect(consumed.claimToken).toBeUndefined()

    // Terminal: no second delivery of the same result, by anyone.
    const again = await repo.claim(delivery.id, { now: 30_300, claimToken: 'other' })
    expect(again).toEqual({ status: 'rejected', reason: 'not-consumable' })
    expect(await repo.markConsumed(delivery.id, 'holder', 'message-2', 30_400)).toBe(false)
    expect((await repo.findById(delivery.id))!.continuationMessageId).toBe('message-1')
  })

  it('records an unreadable result as missing, and still lets the session be told', async () => {
    const repo = repository()
    await ensure('job-unreadable')
    const delivery = (await repo.findByJobId('job-unreadable'))!

    const flagged = await repo.markNeedsAttention(delivery.id, 'result-unreadable', 40_000)
    expect(flagged?.state).toBe('needs-attention')
    expect(flagged?.reason).toBe('result-unreadable')

    // A delivery that says "no result, and why" still has to reach the session, so it stays consumable.
    const claimed = await repo.claim(delivery.id, { now: 40_100, claimToken: 'teller' })
    expect(claimed.status).toBe('claimed')
    expect(await repo.markConsumed(delivery.id, 'teller', 'message-3', 40_200)).toBe(true)

    const consumed = (await repo.findById(delivery.id))!
    expect(consumed.state).toBe('consumed')
    // The reason survives delivery: the ledger records what happened, not only what is outstanding.
    expect(consumed.reason).toBe('result-unreadable')
  })

  it('does not reset a delivery in flight when the job is scanned again', async () => {
    const repo = repository()
    await ensure('job-rescan')
    const delivery = (await repo.findByJobId('job-rescan'))!
    const claimed = await repo.claim(delivery.id, { now: 50_000, claimToken: 'mid-flight' })
    expect(claimed.status).toBe('claimed')

    // The poller and the recovery scan both call ensureForJob; neither may disturb a live claim.
    const rescanned = await repo.ensureForJob({
      jobId: 'job-rescan',
      projectId: 'project-a',
      sessionId: 'session-a',
      outputFiles: ['hpc/out.csv', 'hpc/extra.csv'],
      fingerprint: 'sha256:bbb',
      now: 50_100
    })

    expect(rescanned.id).toBe(delivery.id)
    expect(rescanned.state).toBe('claimed')
    expect(rescanned.claimToken).toBe('mid-flight')
    expect(rescanned.fingerprint).toBe('sha256:aaa')
  })

  it('keeps exactly one delivery per job', async () => {
    const repo = repository()
    const first = await repo.ensureForJob({
      jobId: 'job-single',
      projectId: 'project-a',
      sessionId: 'session-a',
      outputFiles: ['hpc/out.csv'],
      now: 60_000
    })
    const second = await repo.ensureForJob({
      jobId: 'job-single',
      projectId: 'project-a',
      sessionId: 'session-a',
      outputFiles: ['hpc/out.csv'],
      now: 60_100
    })

    expect(second.id).toBe(first.id)
    const all = (await repo.listForSession('session-a')).filter(
      (delivery) => delivery.jobId === 'job-single'
    )
    expect(all).toHaveLength(1)
  })

  it('drains a session oldest first and skips work someone else holds', async () => {
    const repo = repository()
    // Its own session: earlier tests leave rows whose leases have long expired, and taking those over is
    // correct behaviour — just not what this test is about.
    const session = 'session-drain'
    await ensure('job-drain-1', { now: 70_000, sessionId: session })
    await ensure('job-drain-2', { now: 70_100, sessionId: session })
    const held = (await repo.findByJobId('job-drain-1'))!
    await repo.claim(held.id, { now: 70_200, claimToken: 'other-worker' })

    const next = await repo.claimNextForSession(session, { now: 70_300, claimToken: 'drainer' })
    expect(next?.status).toBe('claimed')
    expect(next?.status === 'claimed' && next.delivery.jobId).toBe('job-drain-2')

    // Nothing else is available while the first one is held, and undefined (not an error) means idle.
    const nothing = await repo.claimNextForSession(session, {
      now: 70_400,
      claimToken: 'drainer'
    })
    expect(nothing).toBeUndefined()

    // Once the holder's lease expires, what it was sitting on is taken over rather than stranded.
    const takeover = await repo.claimNextForSession(session, {
      now: 70_200 + 60_001,
      claimToken: 'drainer'
    })
    expect(takeover?.status === 'claimed' && takeover.delivery.jobId).toBe('job-drain-1')
  })
})
