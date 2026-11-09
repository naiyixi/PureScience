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

import type { AcpPromptRequest } from '../../shared/acp'
import {
  buildBackgroundDeliveryContinuation,
  type BackgroundDelivery,
  type BackgroundDeliveryLabels,
  type BackgroundDeliveryReason,
  type BackgroundDeliveryRef
} from '../../shared/background-delivery'
import { resolveInheritablePromptContext } from '../../shared/conversation-graph'
import {
  materializeSessionConversationGraph,
  type PersistedChatSession,
  type PersistedChatMessage
} from '../../shared/session-persistence'
import { BACKGROUND_DELIVERY_LEASE_MS, BackgroundDeliveryRepository } from './repository'

type PromptProvenance = NonNullable<AcpPromptRequest['provenanceContext']>

export type BackgroundDeliveryOwnerDeps = {
  deliveries: BackgroundDeliveryRepository
  sessions: {
    loadSession: (projectId: string, sessionId: string) => Promise<PersistedChatSession | undefined>
    saveSession: (session: PersistedChatSession) => Promise<void>
  }
  // Wording for the text written into the session. A function is accepted so the language can follow
  // the interface at delivery time rather than at construction time: a delivery may land hours after
  // the reader last changed it. Without a resolver the neutral (English) set is used.
  labels:
    BackgroundDeliveryLabels | (() => BackgroundDeliveryLabels | Promise<BackgroundDeliveryLabels>)
  // When present, a pass that delivered something starts the next turn so the agent can work on the
  // result. Never called for a delivery that has no result: there would be nothing to work on.
  startTurn?: (input: {
    sessionId: string
    projectId: string
    deliveryIds: readonly string[]
    prompt: string
    // The delivered results were written into the session as a user message, so that message is the
    // Prompt this app-owned turn answers. It is resolved from the durable graph here rather than from
    // process memory, because the job may have finished while no process was holding the session.
    provenanceContext?: PromptProvenance
  }) => Promise<void>
  // Reports a delivery sitting in needs-attention, so a surface outside the delivery's own session can
  // say so (IC40). Called once per blocked ledger row per pass — not once per transition — which is what
  // lets the consumer be idempotent instead of keeping state of its own; the notification inbox dedupes
  // on the key the report carries. A report must never fail the pass that produced it: a throw is routed
  // to `onReportError` and the pass continues.
  onNeedsAttention?: (input: {
    delivery: BackgroundDelivery
    reason: BackgroundDeliveryReason | undefined
  }) => Promise<void> | void
  onReportError?: (error: unknown) => void
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
  // True when this pass also started the turn that works on the delivered results.
  startedTurn: boolean
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
        const started = await this.startTurnForRun(sessionId, delivered)
        await this.reportNeedsAttention(sessionId)
        return { delivered, blocked, drained: true, startedTurn: started }
      }
      handled.push(claimed.delivery.id)

      const outcome = await this.deliverClaimed(claimed.delivery, claimed.claimToken)
      if (outcome.status === 'delivered') delivered.push(outcome.delivery)
      else blocked.push({ delivery: outcome.delivery, reason: outcome.reason })
    }
  }

  // Reports every delivery of this session that is sitting in needs-attention. Read from the ledger rather
  // than from this pass's own outcome on purpose: a row flagged by an earlier process — the app stopped
  // before anyone could be told — has to be reported too, and this is the one place that sees both. A
  // repeat report is expected, which is why the consumer dedupes on the key rather than counting calls.
  private async reportNeedsAttention(sessionId: string): Promise<void> {
    const report = this.deps.onNeedsAttention
    if (!report) return
    const outstanding = await this.deps.deliveries.listForSession(sessionId)
    for (const delivery of outstanding) {
      if (delivery.state !== 'needs-attention') continue
      try {
        await report({ delivery, reason: delivery.reason })
      } catch (error) {
        this.deps.onReportError?.(error)
      }
    }
  }

  // Wording is resolved per write rather than per construction: a delivery can land hours after the
  // owner was built, and the reader may have switched the interface language in between.
  private async labels(): Promise<BackgroundDeliveryLabels> {
    const { labels } = this.deps
    return typeof labels === 'function' ? await labels() : labels
  }

  // The turn that works on delivered results, started only when there is one. One turn per pass, however
  // many results arrived: they are the same piece of work. A blocked delivery never triggers it — there is
  // nothing to analyse, and inventing an analysis of a result that was never read is the one thing this
  // ledger exists to prevent.
  private async startTurnForRun(
    sessionId: string,
    delivered: readonly BackgroundDelivery[]
  ): Promise<boolean> {
    const deliverable = delivered.filter((delivery) => delivery.reason === undefined)
    if (!this.deps.startTurn || deliverable.length === 0) return false

    const session = await this.deps.sessions
      .loadSession(deliverable[0].projectId, sessionId)
      .catch(() => undefined)
    if (!session) return false

    await this.deps.startTurn({
      sessionId,
      projectId: deliverable[0].projectId,
      deliveryIds: deliverable.map((delivery) => delivery.id),
      prompt: buildBackgroundDeliveryContinuation(deliverable, await this.labels()),
      ...(this.promptAnchorFor(session) ?? {})
    })
    return true
  }

  // Read AFTER the results were written, so the graph includes them: the newest user Prompt on the
  // active Branch is the delivered results themselves. `undefined` is the honest answer when the
  // session has no durable Prompt the ownership proof would accept (a fresh session, or a Prompt from
  // an earlier Runtime Segment) — the dispatch site then names the consequence instead of letting the
  // turn's artifacts die silently. A graph that cannot be materialized is the same answer: a delivery
  // pass must not fail because an anchor could not be read.
  private promptAnchorFor(session: PersistedChatSession): { provenanceContext?: PromptProvenance } {
    try {
      const graph = materializeSessionConversationGraph(session).conversationGraph
      const anchor = graph ? resolveInheritablePromptContext(graph) : undefined
      return anchor ? { provenanceContext: anchor } : {}
    } catch {
      return {}
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
      content: buildBackgroundDeliveryContinuation([delivery], await this.labels()),
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
