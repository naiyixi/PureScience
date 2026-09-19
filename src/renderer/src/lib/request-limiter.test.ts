import { describe, expect, it } from 'vitest'

import { createRequestLimiter } from './request-limiter'

// The fan-outs these bound are reads into one shared engine queue: measured with the engine canary, 52 parallel
// project reads queued ~6x deeper than the same reads limited to 4. These pin the properties the callers rely
// on — the cap holds, order is FIFO, and a slot is released by rejection as well as by success.
const deferred = (): {
  promise: Promise<void>
  resolve: () => void
  reject: (error: Error) => void
} => {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

// Releasing a slot costs a `.then` plus a `.finally`, so a single microtask flush is not enough to observe the
// next task starting; a macrotask hop drains the whole chain.
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

describe('createRequestLimiter', () => {
  it('keeps at most the configured number of tasks in flight, and starts the rest as slots free', async () => {
    const limit = createRequestLimiter(2)
    const gates = [deferred(), deferred(), deferred(), deferred()]
    const started: number[] = []
    const runs = gates.map((gate, index) =>
      limit(async () => {
        started.push(index)
        await gate.promise
        return index
      })
    )

    expect(started).toEqual([0, 1])
    gates[0].resolve()
    await flush()
    expect(started).toEqual([0, 1, 2])
    gates[1].resolve()
    gates[2].resolve()
    await flush()
    expect(started).toEqual([0, 1, 2, 3])

    gates[3].resolve()
    await expect(Promise.all(runs)).resolves.toEqual([0, 1, 2, 3])
  })

  it('preserves FIFO order and releases the slot when a task rejects', async () => {
    const limit = createRequestLimiter(1)
    const first = deferred()
    const order: string[] = []
    const failing = limit(async () => {
      order.push('failing')
      await first.promise
      throw new Error('read failed')
    })
    const following = limit(async () => {
      order.push('following')
      return 'ok'
    })

    expect(order).toEqual(['failing'])
    first.resolve()
    await expect(failing).rejects.toThrow('read failed')
    await expect(following).resolves.toBe('ok')
    expect(order).toEqual(['failing', 'following'])
  })

  it('refuses a concurrency that would not bound anything', () => {
    expect(() => createRequestLimiter(0)).toThrow(/positive integer/)
    expect(() => createRequestLimiter(1.5)).toThrow(/positive integer/)
    expect(() => createRequestLimiter(Number.NaN)).toThrow(/positive integer/)
  })

  it('holds the cap when a running task queues more work without awaiting it', async () => {
    // The shape that matters in the app: a batch of reads whose completion stages the next batch. (A task that
    // awaits another task of the same limiter could exhaust the slots by construction, so callers do not do
    // that — they queue and let the pump decide.)
    const limit = createRequestLimiter(2)
    let inFlight = 0
    let peak = 0
    let queueNext = (): void => {}
    const run = (depth: number): Promise<void> =>
      limit(async () => {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        await Promise.resolve()
        if (depth > 0) queueNext()
        inFlight -= 1
      })

    for (let round = 0; round < 5; round += 1) {
      queueNext = () => {
        void run(0)
      }
      const batch = [run(1), run(1), run(1)]
      await Promise.all(batch)
      await flush()
    }

    expect(peak).toBeLessThanOrEqual(2)
  })
})
