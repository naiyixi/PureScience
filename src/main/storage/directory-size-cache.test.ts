import { describe, expect, it, vi } from 'vitest'

import { createDirectorySizeCache } from './directory-size-cache'
import type { DirectorySizeMeasurement } from './usage'

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

const measured = (bytes: number): DirectorySizeMeasurement => ({ state: 'measured', bytes })

// A walk whose resolution the test controls, so "the read gives up but the walk finishes into the cache"
// can be asserted without waiting on a real tree.
const deferred = (): {
  promise: Promise<DirectorySizeMeasurement>
  resolve: (value: DirectorySizeMeasurement) => void
} => {
  let resolve: (value: DirectorySizeMeasurement) => void = () => {}
  const promise = new Promise<DirectorySizeMeasurement>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

describe('directory size cache', () => {
  it('answers a cold read without waiting for the walk, then serves the reading the walk landed', async () => {
    // The panel asks for the environment list the moment Settings → Runtimes opens. Waiting for a 44,716-
    // file walk is what put 4.8–5.0 s of handler time in front of it on the real machine; the first answer
    // is "not measured yet" (absent), never a 0.
    const walk = deferred()
    const measure = vi.fn(() => walk.promise)
    const cache = createDirectorySizeCache({ measure, waitBudgetMs: 10 })

    await expect(cache.read('/envs/default-python')).resolves.toBeUndefined()
    expect(measure).toHaveBeenCalledTimes(1)

    walk.resolve(measured(1_300_000_000))
    await flush()
    await expect(cache.read('/envs/default-python')).resolves.toBe(1_300_000_000)
    // The second read is served from the cache: the walk happened once.
    expect(measure).toHaveBeenCalledTimes(1)
  })

  it('joins the walk in flight instead of starting a second one for the same prefix', async () => {
    const walk = deferred()
    const measure = vi.fn(() => walk.promise)
    const cache = createDirectorySizeCache({ measure, waitBudgetMs: 10 })

    const [first, second] = await Promise.all([cache.read('/envs/a'), cache.read('/envs/a')])
    expect(first).toBeUndefined()
    expect(second).toBeUndefined()
    expect(measure).toHaveBeenCalledTimes(1)
    walk.resolve(measured(10))
    await flush()
  })

  it('serves a fresh reading without walking again, and hands back a stale one while refreshing', async () => {
    let bytes = 100
    const measure = vi.fn(async () => measured(bytes))
    let clock = 1_000
    const cache = createDirectorySizeCache({ measure, ttlMs: 60_000, now: () => clock })

    await cache.read('/envs/a')
    await flush()
    clock += 30_000
    await expect(cache.read('/envs/a')).resolves.toBe(100)
    expect(measure).toHaveBeenCalledTimes(1)

    // Past the TTL the old number is still handed back — a minute-old size beats a panel that stalls —
    // and a refresh runs behind the reader.
    bytes = 250
    clock += 40_000
    await expect(cache.read('/envs/a')).resolves.toBe(100)
    await flush()
    expect(measure).toHaveBeenCalledTimes(2)
    await expect(cache.read('/envs/a')).resolves.toBe(250)
  })

  it('does not cache a walk nobody could complete as a number, and does not re-walk it on every read', async () => {
    const measure = vi.fn(async (): Promise<DirectorySizeMeasurement> => ({
      state: 'unavailable',
      reason: 'unreadable'
    }))
    let clock = 0
    const cache = createDirectorySizeCache({ measure, ttlMs: 60_000, now: () => clock })

    // "Could not look" is not "held 0 bytes": the caller gets an absent reading either way, and the row
    // then prints no size at all.
    await expect(cache.read('/envs/sealed')).resolves.toBeUndefined()
    await expect(cache.read('/envs/sealed')).resolves.toBeUndefined()
    // A burst of reads must not re-walk an unreadable tree once per read …
    expect(measure).toHaveBeenCalledTimes(1)

    // … and after the TTL it tries again, because the next look may succeed.
    clock += 61_000
    await expect(cache.read('/envs/sealed')).resolves.toBeUndefined()
    expect(measure).toHaveBeenCalledTimes(2)
  })

  it('drops one prefix when the app itself changed it, and everything on clear', async () => {
    let bytes = 10
    const measure = vi.fn(async () => measured(bytes))
    const cache = createDirectorySizeCache({ measure })

    await cache.read('/envs/a')
    await flush()
    bytes = 20
    cache.invalidate('/envs/a')
    await expect(cache.read('/envs/a')).resolves.toBe(20)
    await flush()

    cache.clear()
    bytes = 30
    await cache.read('/envs/a')
    await flush()
    await expect(cache.read('/envs/a')).resolves.toBe(30)
  })
})
