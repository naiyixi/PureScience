// The background delivery ledger.
//
// A finished job's result must reach its session even when no window is alive to notice it, so the
// delivery is a main-process record with a state machine rather than a renderer effect. Two properties
// carry the weight here and are what the tests are built around:
//
//   * a claim is a compare-and-swap on (state, claimExpiresAt) — two workers cannot both take the same
//     delivery, and a worker that dies mid-delivery leaves a lease that expires, so the result is taken
//     over instead of being stranded;
//   * every state change after the claim is fenced by the claim token, so a worker whose lease was
//     taken over cannot come back and write.

import { randomUUID } from 'node:crypto'

import type { BackgroundDelivery as PrismaBackgroundDelivery, PrismaClient } from '@prisma/client'

import {
  BACKGROUND_DELIVERY_SCHEMA_VERSION,
  BACKGROUND_DELIVERY_STATES,
  BACKGROUND_DELIVERY_CONSUMABLE_STATES,
  type BackgroundDelivery,
  type BackgroundDeliveryClaimResult,
  type BackgroundDeliveryReason,
  type BackgroundDeliverySourceKind,
  type BackgroundDeliveryState
} from '../../shared/background-delivery'

// How long a worker holds a delivery before its claim is up for grabs. Long enough for a turn to be
// written, short enough that a crash is recovered in the same session rather than the next day.
export const BACKGROUND_DELIVERY_LEASE_MS = 60_000

// Only these delegates are needed, so the repository can be exercised against a narrow client.
type BackgroundDeliveryClient = Pick<PrismaClient, 'backgroundDelivery' | '$executeRaw'>

// Resolves the client on demand so a failed initialization is not held forever (see projects/repository).
type BackgroundDeliveryClientProvider = () => Promise<BackgroundDeliveryClient>

// An unrecognized state is surfaced as needing attention: it must never be silently treated as delivered.
const asState = (value: string): BackgroundDeliveryState =>
  (BACKGROUND_DELIVERY_STATES as readonly string[]).includes(value)
    ? (value as BackgroundDeliveryState)
    : 'needs-attention'

const asSourceKind = (value: string): BackgroundDeliverySourceKind =>
  value === 'notebook' ? 'notebook' : 'compute'

const parseOutputFiles = (json: string): string[] => {
  try {
    const parsed: unknown = JSON.parse(json)
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === 'string')
      : []
  } catch {
    return []
  }
}

export const toBackgroundDelivery = (row: PrismaBackgroundDelivery): BackgroundDelivery => ({
  schemaVersion: BACKGROUND_DELIVERY_SCHEMA_VERSION,
  id: row.id,
  projectId: row.projectId,
  sessionId: row.sessionId,
  jobId: row.jobId,
  sourceKind: asSourceKind(row.sourceKind),
  state: asState(row.state),
  outputFiles: parseOutputFiles(row.outputFiles),
  fingerprint: row.fingerprint ?? undefined,
  claimToken: row.claimToken ?? undefined,
  claimExpiresAt: row.claimExpiresAt?.getTime(),
  continuationMessageId: row.continuationMessageId ?? undefined,
  reason: (row.reason as BackgroundDeliveryReason | null) ?? undefined,
  createdAt: row.createdAt.getTime(),
  updatedAt: row.updatedAt.getTime(),
  consumedAt: row.consumedAt?.getTime()
})

export type EnsureBackgroundDeliveryInput = {
  jobId: string
  projectId: string
  sessionId: string
  sourceKind?: BackgroundDeliverySourceKind
  outputFiles?: readonly string[]
  fingerprint?: string
  now: number
}

export type ClaimBackgroundDeliveryOptions = {
  now: number
  leaseMs?: number
  // Deterministic in tests; generated when omitted.
  claimToken?: string
  // Deliveries this pass has already handled. A blocked delivery stays consumable so a later pass can try
  // again, which means the pass itself has to leave it alone instead of claiming it in a loop.
  exclude?: readonly string[]
}

export class BackgroundDeliveryRepository {
  constructor(private readonly client: BackgroundDeliveryClientProvider) {}

  // Idempotent by job id. Re-running is the normal case — the poller and the recovery scan both call it —
  // so an existing row keeps whatever progress it has: a claim in flight is never reset by a later scan.
  async ensureForJob(input: EnsureBackgroundDeliveryInput): Promise<BackgroundDelivery> {
    const client = await this.client()
    const files = input.outputFiles ?? []
    const hasResult = files.length > 0 || input.fingerprint !== undefined
    const existing = await client.backgroundDelivery.findUnique({ where: { jobId: input.jobId } })

    if (existing) {
      // Only a delivery that is still waiting for its result is advanced. Anything further along is
      // left exactly as it is, including its claim.
      if (existing.state === 'waiting-result' && hasResult) {
        const updated = await client.backgroundDelivery.update({
          where: { id: existing.id },
          data: {
            state: 'pending',
            outputFiles: JSON.stringify(files),
            fingerprint: input.fingerprint ?? null,
            updatedAt: new Date(input.now)
          }
        })
        return toBackgroundDelivery(updated)
      }
      return toBackgroundDelivery(existing)
    }

    const created = await client.backgroundDelivery.create({
      data: {
        id: randomUUID(),
        projectId: input.projectId,
        sessionId: input.sessionId,
        jobId: input.jobId,
        sourceKind: input.sourceKind ?? 'compute',
        state: hasResult ? 'pending' : 'waiting-result',
        outputFiles: JSON.stringify(files),
        fingerprint: input.fingerprint ?? null,
        updatedAt: new Date(input.now),
        createdAt: new Date(input.now)
      }
    })
    return toBackgroundDelivery(created)
  }

  async findByJobId(jobId: string): Promise<BackgroundDelivery | undefined> {
    const client = await this.client()
    const row = await client.backgroundDelivery.findUnique({ where: { jobId } })
    return row ? toBackgroundDelivery(row) : undefined
  }

  async listForSession(sessionId: string): Promise<BackgroundDelivery[]> {
    const client = await this.client()
    const rows = await client.backgroundDelivery.findMany({
      where: { sessionId },
      orderBy: { createdAt: 'desc' }
    })
    return rows.map(toBackgroundDelivery)
  }

  async findById(id: string): Promise<BackgroundDelivery | undefined> {
    const client = await this.client()
    const row = await client.backgroundDelivery.findUnique({ where: { id } })
    return row ? toBackgroundDelivery(row) : undefined
  }

  // The compare-and-swap. The guard lives in the WHERE clause so the check and the write are one
  // statement: a live claim (claimExpiresAt in the future) makes the update match no rows, which is
  // what makes two workers racing for the same delivery safe.
  async claim(
    id: string,
    options: ClaimBackgroundDeliveryOptions
  ): Promise<BackgroundDeliveryClaimResult> {
    const client = await this.client()
    const now = options.now
    const leaseMs = options.leaseMs ?? BACKGROUND_DELIVERY_LEASE_MS
    const claimToken = options.claimToken ?? randomUUID()
    const nowDate = new Date(now)

    const result = await client.backgroundDelivery.updateMany({
      where: {
        id,
        state: { in: [...BACKGROUND_DELIVERY_CONSUMABLE_STATES] },
        OR: [{ claimToken: null }, { claimExpiresAt: null }, { claimExpiresAt: { lte: nowDate } }]
      },
      data: {
        state: 'claimed',
        claimToken,
        claimExpiresAt: new Date(now + leaseMs),
        updatedAt: nowDate
      }
    })

    if (result.count === 1) {
      const claimed = await this.findById(id)
      if (claimed) return { status: 'claimed', delivery: claimed, claimToken }
    }

    // Nothing was claimed: say which of the two reasons it was, rather than a bare failure.
    const current = await this.findById(id)
    if (!current) return { status: 'rejected', reason: 'job-not-found' }
    const consumable = (BACKGROUND_DELIVERY_CONSUMABLE_STATES as readonly string[]).includes(
      current.state
    )
    return { status: 'rejected', reason: consumable ? 'claim-held' : 'not-consumable' }
  }

  // Claims the oldest delivery that is ready for this session, so a scheduler can drain a session
  // without holding its own bookkeeping. Returns undefined when there is nothing to do.
  async claimNextForSession(
    sessionId: string,
    options: ClaimBackgroundDeliveryOptions
  ): Promise<BackgroundDeliveryClaimResult | undefined> {
    const client = await this.client()
    const excluded = new Set(options.exclude ?? [])
    const candidates = await client.backgroundDelivery.findMany({
      where: { sessionId },
      orderBy: { createdAt: 'asc' }
    })
    for (const candidate of candidates) {
      if (excluded.has(candidate.id)) continue
      const delivery = toBackgroundDelivery(candidate)
      if (!(BACKGROUND_DELIVERY_CONSUMABLE_STATES as readonly string[]).includes(delivery.state)) {
        continue
      }
      const attempt = await this.claim(delivery.id, options)
      if (attempt.status === 'claimed') return attempt
      // A live claim on the oldest row just means someone else is on it; keep looking.
    }
    return undefined
  }

  // Every write after the claim is fenced by the token: a worker whose lease expired and was taken over
  // must not be able to write under its old token.
  private async writeAsHolder(
    id: string,
    claimToken: string,
    now: number,
    data: Record<string, unknown>
  ): Promise<boolean> {
    const client = await this.client()
    const result = await client.backgroundDelivery.updateMany({
      where: { id, claimToken },
      data: { ...data, updatedAt: new Date(now) }
    })
    return result.count === 1
  }

  async markDispatching(id: string, claimToken: string, now: number): Promise<boolean> {
    return this.writeAsHolder(id, claimToken, now, { state: 'dispatching' })
  }

  async markConsumed(
    id: string,
    claimToken: string,
    continuationMessageId: string,
    now: number
  ): Promise<boolean> {
    // The reason is kept: "the result could not be read" stays true after the session has been told, and
    // the ledger is the record of what happened, not only of what is still outstanding.
    return this.writeAsHolder(id, claimToken, now, {
      state: 'consumed',
      continuationMessageId,
      consumedAt: new Date(now),
      claimToken: null,
      claimExpiresAt: null
    })
  }

  // A result that could not be read still has something to say, so it stays consumable: the session is
  // told there is no result, and why. It is never replaced by an invented analysis.
  async markNeedsAttention(
    id: string,
    reason: BackgroundDeliveryReason,
    now: number
  ): Promise<BackgroundDelivery | undefined> {
    const client = await this.client()
    const current = await client.backgroundDelivery.findUnique({ where: { id } })
    if (!current || current.state === 'consumed') return undefined
    const updated = await client.backgroundDelivery.update({
      where: { id },
      data: {
        state: 'needs-attention',
        reason,
        claimToken: null,
        claimExpiresAt: null,
        updatedAt: new Date(now)
      }
    })
    return toBackgroundDelivery(updated)
  }

  // Called on a clean stop so the next run does not have to wait out the lease.
  async releaseClaim(id: string, claimToken: string, now: number): Promise<boolean> {
    return this.writeAsHolder(id, claimToken, now, {
      state: 'pending',
      claimToken: null,
      claimExpiresAt: null
    })
  }
}

// Re-exported for the scheduler and its tests, which reason about claims without a database.
export { isBackgroundDeliveryClaimLive } from '../../shared/background-delivery'
