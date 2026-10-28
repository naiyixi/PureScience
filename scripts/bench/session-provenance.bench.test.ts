// Times the graph materialization that runs after every session save (`captureFinalizedMessages`
// starts with it), plus the candidate O(1) fingerprint that could let the capture be skipped.
// Run: PURESCIENCE_BENCH_SESSION_PROVENANCE=1 PURESCIENCE_BENCH_REAL_SESSION=<file.json> \
//      npx vitest run scripts/bench/session-provenance.bench.test.ts
import { appendFileSync } from 'node:fs'
import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import {
  materializeSessionConversationGraph,
  type PersistedChatSession
} from '../../src/shared/session-persistence'

const enabled = process.env.PURESCIENCE_BENCH_SESSION_PROVENANCE === '1'
const file = process.env.PURESCIENCE_BENCH_REAL_SESSION

describe.skipIf(!enabled || !file)('session provenance cost', () => {
  it('times graph materialization and the candidate fingerprint', () => {
    const raw = readFileSync(file as string, 'utf8')
    const parsed = JSON.parse(raw) as { session: PersistedChatSession }
    const session = parsed.session ?? (parsed as unknown as PersistedChatSession)

    const out = process.env.PURESCIENCE_BENCH_OUT ?? '/tmp/session-provenance.txt'

    // Fingerprint candidate: O(1) from fields the coordinator already holds in memory.
    const fingerprint = [
      session.messages?.length ?? 0,
      session.messages?.at(-1)?.id ?? '',
      session.activities?.length ?? 0,
      session.activityGroups?.length ?? 0
    ].join('|')

    const durations: number[] = []
    for (let index = 0; index < 5; index += 1) {
      const started = process.hrtime.bigint()
      materializeSessionConversationGraph(session)
      durations.push(Number(process.hrtime.bigint() - started) / 1e6)
    }
    const sorted = [...durations].sort((a, b) => a - b)

    appendFileSync(
      out,
      `session bytes=${raw.length} messages=${session.messages?.length ?? 0} ` +
        `activities=${session.activities?.length ?? 0} ` +
        `materialize_cold=${durations[0].toFixed(1)}ms ` +
        `materialize_p50=${sorted[Math.floor(sorted.length / 2)].toFixed(1)}ms ` +
        `fingerprint=${fingerprint.slice(0, 40)}\n`
    )
    expect(durations[0]).toBeGreaterThan(0)
  }, 180_000)
})
