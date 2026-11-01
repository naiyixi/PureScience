import type { Prisma, PrismaClient } from '@prisma/client'

export const MAX_UNREAD_TASK_SESSIONS = 1000
const SQLITE_MUTATION_CHUNK_SIZE = 400

type UnreadTaskClient = Pick<PrismaClient, '$transaction' | 'unreadTaskSession'>
type UnreadTaskClientProvider = () => Promise<UnreadTaskClient>

// Preserves insertion order while deduplicating; snapshots additionally bound database growth.
const normalizeSessionIds = (values: string[], limit?: number): string[] => {
  const unique = new Set<string>()

  for (const value of values) {
    const sessionId = value.trim()
    if (sessionId) unique.add(sessionId)
  }

  const normalized = [...unique]
  return limit === undefined ? normalized : normalized.slice(-limit)
}

const normalizeUnreadSessionIds = (values: string[]): string[] =>
  normalizeSessionIds(values, MAX_UNREAD_TASK_SESSIONS)

// Bounds each delete statement independently of the SQLite build's maximum bind-variable count.
const chunkValues = <T>(values: T[]): T[][] => {
  const chunks: T[][] = []

  for (let index = 0; index < values.length; index += SQLITE_MUTATION_CHUNK_SIZE) {
    chunks.push(values.slice(index, index + SQLITE_MUTATION_CHUNK_SIZE))
  }

  return chunks
}

// Named failure for a refused snapshot: the sizes are what the caller's `unread task state failed`
// line needs to say how much state was at stake (a snapshot of 3 and one of 900 used to fail with the
// same bare Prisma message), and the original error travels as `cause` so nothing is lost.
export class UnreadTaskReconcileError extends Error {
  constructor(
    readonly sizes: { desired: number; existing: number; created: number; deleted: number },
    cause: unknown
  ) {
    super(
      `unread task reconcile failed (desired=${sizes.desired} existing=${sizes.existing} created=${sizes.created} deleted=${sizes.deleted}): ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause }
    )
    this.name = 'UnreadTaskReconcileError'
  }
}

// Owns the durable unread projection while the controller remains responsible for live policy state.
export class UnreadTaskDbRepository {
  private operationTail: Promise<unknown> = Promise.resolve()

  constructor(private readonly getClient: UnreadTaskClientProvider) {}

  // Reads only the newest bounded rows while returning them in controller insertion order.
  async load(): Promise<string[]> {
    const client = await this.getClient()
    const rows = await client.unreadTaskSession.findMany({
      orderBy: { id: 'desc' },
      take: MAX_UNREAD_TASK_SESSIONS
    })

    // Query newest-first for a bounded read, then restore the controller's oldest-to-newest Set order.
    return normalizeUnreadSessionIds(rows.reverse().map((row) => row.sessionId))
  }

  // Copies the caller's snapshot before queueing so later mutations cannot change scheduled work.
  save(sessionIds: string[]): Promise<void> {
    const snapshot = normalizeUnreadSessionIds(sessionIds)
    return this.enqueue(() => this.reconcile(snapshot))
  }

  // Reconciles unread metadata only after a complete authoritative Session JSON scan. The caller
  // supplies Sessions still eligible for attention, repairing interrupted archive cleanup and
  // headless deletions without introducing another durable workflow.
  reconcileSessionCatalog(attentionEligibleSessionIds: string[]): Promise<string[]> {
    const eligible = new Set(normalizeSessionIds(attentionEligibleSessionIds))

    return this.enqueue(async () => {
      const client = await this.getClient()
      // Read, decide, then write as ONE batch. See `reconcile` for why the decision does not live
      // inside an interactive transaction: its callback is a chain of awaits inside a 5 s budget, and
      // a stalled event loop (measured on the real machine: 2.4 s windows) can expire it mid-way.
      const unreadRows = await client.unreadTaskSession.findMany({
        orderBy: { id: 'asc' },
        select: { sessionId: true }
      })
      const removedSessionIds = unreadRows
        .map((row) => row.sessionId)
        .filter((sessionId) => !eligible.has(sessionId))

      const statements = chunkValues(removedSessionIds).map((ids) =>
        client.unreadTaskSession.deleteMany({ where: { sessionId: { in: ids } } })
      )
      if (statements.length > 0) await client.$transaction(statements)

      return removedSessionIds
    })
  }

  // Applies one complete controller snapshot without rewriting rows that remain unread.
  private async reconcile(snapshot: string[]): Promise<void> {
    const client = await this.getClient()

    // One batch transaction, not an interactive one: retained rows keep their ordering IDs and a
    // crash cannot expose a partially applied snapshot, but nothing of ours runs between statements.
    //
    // The interactive shape this replaces opened a transaction and then issued one `create` per
    // missing session inside its callback. Prisma gives that callback a 5 s budget, and on the real
    // machine it expired before even the first query: `Transaction already closed: A query cannot be
    // executed on an expired transaction` at `transaction.unreadTaskSession.findMany` (app main.log
    // 2026-10-29 17:39 and 2026-11-01 01:15, `unread task state failed`). The whole snapshot was
    // dropped there and the durable unread set silently diverged from memory -- after a relaunch the
    // badges came back from a state the user had already read. A batch transaction has no callback
    // for an event-loop stall to run through: the statements either all land or none do.
    //
    // Reading outside the transaction is deliberate: `enqueue` serializes every operation of this
    // class and no other writer touches this table, so the difference computed here is the one the
    // batch applies. Chunk sizes stay below conservative SQLite bind limits.
    const rows = await client.unreadTaskSession.findMany({ orderBy: { id: 'asc' } })
    const desiredSessionIds = new Set(snapshot)
    const existingSessionIds = new Set(rows.map((row) => row.sessionId))
    const deletedRowIds = rows
      .filter((row) => !desiredSessionIds.has(row.sessionId))
      .map((row) => row.id)
    const createdSessionIds = snapshot.filter((sessionId) => !existingSessionIds.has(sessionId))

    const statements: Prisma.PrismaPromise<Prisma.BatchPayload>[] = [
      ...chunkValues(deletedRowIds).map((rowIds) =>
        client.unreadTaskSession.deleteMany({ where: { id: { in: rowIds } } })
      ),
      ...chunkValues(createdSessionIds).map((sessionIds) =>
        client.unreadTaskSession.createMany({
          data: sessionIds.map((sessionId) => ({ sessionId }))
        })
      )
    ]
    if (statements.length === 0) return

    try {
      await client.$transaction(statements)
    } catch (error) {
      // The failure used to arrive as a bare Prisma message, which said nothing about how much state
      // was at stake. The sizes travel with it now: a snapshot of 3 and one of 900 fail identically
      // otherwise, and only the second is worth waking someone for.
      throw new UnreadTaskReconcileError(
        {
          desired: snapshot.length,
          existing: existingSessionIds.size,
          created: createdSessionIds.length,
          deleted: deletedRowIds.length
        },
        error
      )
    }
  }

  // Snapshot and catalog operations share one queue so stale full-state writes cannot overtake a
  // newer authoritative catalog reconciliation.
  private enqueue<Result>(operation: () => Promise<Result>): Promise<Result> {
    const run = this.operationTail.then(operation, operation)
    this.operationTail = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }
}

export type { UnreadTaskClient, UnreadTaskClientProvider }
