// Delivering a background result into its session.
//
// The renderer used to own this step, which meant a result only landed while a window was alive to notice
// it. Here the main process writes the turn, so the delivery happens whether or not anyone is looking.
//
// The one thing a file plus a database cannot give is a single atomic commit, so the pair is ordered and
// made re-entrant instead: the message is written first and carries a structured reference to the delivery,
// and a later pass that finds that reference consumes the delivery without writing a second message. A
// worker that dies between the two steps therefore leaves a delivery that is delivered exactly once.

import { randomUUID } from 'node:crypto'

import {
  buildBackgroundDeliveryContinuation,
  type BackgroundDelivery,
  type BackgroundDeliveryLabels,
  type BackgroundDeliveryReason,
  type BackgroundDeliveryRef
} from '../../shared/background-delivery'
import type { PersistedChatSession, PersistedChatMessage } from '../../shared/session-persistence'
import { BACKGROUND_DELIVERY_LEASE_MS, BackgroundDeliveryRepository } from './repository'

export type BackgroundDeliveryOwnerDeps = {
  deliveries: BackgroundDeliveryRepository
  sessions: {
    loadSession: (projectId: string, sessionId: string) => Promise<PersistedChatSession | undefined>
    saveSession: (session: PersistedChatSession) => Promise<void>
  }
  // Wording for the text written into the session. Defaults to the neutral set, because main has no UI
  // language; the UI renders its own localized prose from the structured reference.
  labels: BackgroundDeliveryLabels
  now?: () => number
  leaseMs?: number
  newClaimToken?: () => string
  newMessageId?: () => string
}

export type BackgroundDeliveryRun = {
  // Deliveries consumed by this run, in the order they landed.
  delivered: readonly BackgroundDelivery[]
  // Deliveries left for attention, with the reason they could not be delivered.
  blocked: readonly { delivery: BackgroundDelivery; reason: BackgroundDeliveryReason }[]
  // True when there was nothing left to claim.
  drained: boolean
}

export const backgroundDeliveryRef = (delivery: BackgroundDelivery): BackgroundDeliveryRef => ({
  deliveryId: delivery.id,
  jobId: delivery.jobId,
  sourceKind: delivery.sourceKind,
  outputFiles: delivery.outputFiles,
  fingerprint: delivery.fingerprint,
  reason: delivery.reason
})

// The message already carrying this delivery, if a previous pass wrote one. This is what makes a crash
// between the write and the consume harmless.
export const findDeliveredMessage = (
  session: PersistedChatSession,
  deliveryId: string
): PersistedChatMessage | undefined =>
  session.messages.find((message) => message.backgroundDelivery?.deliveryId === deliveryId)

export class BackgroundDeliveryOwner {
  private readonly now: () => number
  private readonly leaseMs: number
  private readonly newClaimToken: () => string
  private readonly newMessageId: () => string

  constructor(private readonly deps: BackgroundDeliveryOwnerDeps) {
    this.now = deps.now ?? (() => Date.now())
    this.leaseMs = deps.leaseMs ?? BACKGROUND_DELIVERY_LEASE_MS
    this.newClaimToken = deps.newClaimToken ?? (() => randomUUID())
    this.newMessageId =
      deps.newMessageId ?? (() => `message-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  }

  // A finished job's result is registered here; it is the same call the poller and the recovery scan make,
  // which is why it is idempotent by job id.
  async registerJobResult(input: {
    jobId: string
    projectId: string
    sessionId: string
    outputFiles?: readonly string[]
    fingerprint?: string
  }): Promise<BackgroundDelivery> {
    return this.deps.deliveries.ensureForJob({
      ...input,
      sourceKind: 'compute',
      now: this.now()
    })
  }

  // Drains a session: claim, deliver, repeat. Returns when nothing more can be claimed, so a caller can
  // run this on every tick without holding bookkeeping of its own.
  //
  // A delivery that could not be delivered stays consumable, so that a later tick can try again once its
  // session is readable. Within one pass that means each delivery is handled at most once: `handled` is
  // what keeps the loop from claiming the same blocked delivery forever.
  async deliverSession(sessionId: string): Promise<BackgroundDeliveryRun> {
    const delivered: BackgroundDelivery[] = []
    const blocked: { delivery: BackgroundDelivery; reason: BackgroundDeliveryReason }[] = []
    const handled: string[] = []

    for (;;) {
      const claimed = await this.deps.deliveries.claimNextForSession(sessionId, {
        now: this.now(),
        leaseMs: this.leaseMs,
        claimToken: this.newClaimToken(),
        exclude: handled
      })
      if (!claimed || claimed.status !== 'claimed') {
        return { delivered, blocked, drained: true }
      }
      handled.push(claimed.delivery.id)

      const outcome = await this.deliverClaimed(claimed.delivery, claimed.claimToken)
      if (outcome.status === 'delivered') delivered.push(outcome.delivery)
      else blocked.push({ delivery: outcome.delivery, reason: outcome.reason })
    }
  }

  private async deliverClaimed(
    delivery: BackgroundDelivery,
    claimToken: string
  ): Promise<
    | { status: 'delivered'; delivery: BackgroundDelivery }
    | { status: 'blocked'; delivery: BackgroundDelivery; reason: BackgroundDeliveryReason }
  > {
    const now = this.now()
    // Fenced: if this worker's lease was taken over, nothing below happens under the stale token.
    await this.deps.deliveries.markDispatching(delivery.id, claimToken, now)

    const session = await this.deps.sessions
      .loadSession(delivery.projectId, delivery.sessionId)
      .catch(() => undefined)
    if (!session) {
      const flagged = await this.deps.deliveries.markNeedsAttention(
        delivery.id,
        'session-unavailable',
        now
      )
      return {
        status: 'blocked',
        delivery: flagged ?? delivery,
        reason: 'session-unavailable'
      }
    }

    const existing = findDeliveredMessage(session, delivery.id)
    if (existing) {
      // A previous pass wrote the turn but did not get to mark it consumed. Deliver nothing twice: adopt
      // the message that is already in the session.
      await this.deps.deliveries.markConsumed(delivery.id, claimToken, existing.id, now)
      const consumed = await this.deps.deliveries.findById(delivery.id)
      return { status: 'delivered', delivery: consumed ?? delivery }
    }

    const message: PersistedChatMessage = {
      id: this.newMessageId(),
      role: 'user',
      content: buildBackgroundDeliveryContinuation([delivery], this.deps.labels),
      status: 'complete',
      eventIds: [],
      createdAt: now,
      updatedAt: now,
      backgroundDelivery: backgroundDeliveryRef(delivery)
    }

    await this.deps.sessions.saveSession({
      ...session,
      messages: [...session.messages, message],
      updatedAt: now
    })
    await this.deps.deliveries.markConsumed(delivery.id, claimToken, message.id, now)

    const consumed = await this.deps.deliveries.findById(delivery.id)
    return { status: 'delivered', delivery: consumed ?? delivery }
  }

  // A clean stop hands its work back immediately rather than making the next run wait out the lease.
  async releaseSession(sessionId: string): Promise<void> {
    const outstanding = await this.deps.deliveries.listForSession(sessionId)
    for (const delivery of outstanding) {
      if (delivery.claimToken) {
        await this.deps.deliveries.releaseClaim(delivery.id, delivery.claimToken, this.now())
      }
    }
  }
}
