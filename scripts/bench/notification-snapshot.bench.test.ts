// Does `snapshot()` wait behind the write queue? Measured with a real project DB: idle, then with 120
// concurrent `record()` calls holding the queue. If reading joins the queue, the busy-case latency tracks
// the writes; the fix is visible as busy-case latency staying flat.
// Run: PURESCIENCE_BENCH_INBOX=1 npx vitest run scripts/bench/notification-snapshot.bench.test.ts
import { appendFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { createProjectDbClient, ensureProjectSchema } from '../../src/main/projects/prisma-client'
import { NotificationInboxDbRepository } from '../../src/main/notifications/notification-inbox-repository'

const enabled = process.env.PURESCIENCE_BENCH_INBOX === '1'

describe.skipIf(!enabled)('notification snapshot latency', () => {
  it('measures snapshot latency with an idle and a busy write queue', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'ps-inbox-bench-'))
    const client = createProjectDbClient(storageRoot)
    await ensureProjectSchema(client)
    const repo = new NotificationInboxDbRepository(() => Promise.resolve(client))
    const out = process.env.PURESCIENCE_BENCH_OUT ?? '/tmp/inbox-bench.txt'

    const time = async (): Promise<number> => {
      const started = process.hrtime.bigint()
      await repo.snapshot(50)
      return Number(process.hrtime.bigint() - started) / 1e6
    }

    // Seed so the snapshot has rows to read, like the device (600 rows there).
    for (let index = 0; index < 200; index += 1) {
      await repo.record({
        id: `seed-${index}`,
        dedupeKey: `seed-${index}`,
        kind: 'task.completed',
        originId: `seed-${index}`,
        title: `seed ${index}`,
        summary: 'x'.repeat(400)
      })
    }

    const idle: number[] = []
    for (let index = 0; index < 5; index += 1) idle.push(await time())

    // Hold the queue: 120 records in flight, each doing findUnique + create + expiry scan.
    const writes: Array<Promise<unknown>> = []
    for (let index = 0; index < 120; index += 1) {
      writes.push(
        repo.record({
          id: `busy-${index}`,
          dedupeKey: `busy-${index}`,
          kind: 'task.completed',
          originId: `busy-${index}`,
          title: `busy ${index}`,
          summary: 'x'.repeat(400)
        })
      )
    }
    const busy: number[] = []
    for (let index = 0; index < 5; index += 1) busy.push(await time())
    await Promise.all(writes)

    const median = (values: number[]): number =>
      [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
    appendFileSync(
      out,
      `rows=200 idle_p50=${median(idle).toFixed(1)}ms busy_p50=${median(busy).toFixed(1)}ms ` +
        `busy_all=${busy.map((v) => v.toFixed(0)).join(',')}\n`
    )

    await rm(storageRoot, { recursive: true, force: true })
    expect(idle.length).toBe(5)
  }, 300_000)
})
