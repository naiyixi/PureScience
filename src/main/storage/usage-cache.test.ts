import { describe, expect, it, vi } from 'vitest'

import type { StorageUsage } from './usage'
import { createStorageUsageCache } from './usage-cache'

const usage = (totalBytes: number): StorageUsage => ({
  categories: [{ key: 'artifacts', bytes: totalBytes }],
  totalBytes
})

// A compute whose resolution the test controls, so "returns the stale numbers immediately" can be
// asserted without waiting on a real walk.
const deferred = (): { promise: Promise<StorageUsage>; resolve: (value: StorageUsage) => void } => {
  let resolve: (value: StorageUsage) => void = () => {}
  const promise = new Promise<StorageUsage>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

describe('storage usage cache', () => {
  it('waits for the scan only when there is nothing to show', async () => {
    const pending = deferred()
    const compute = vi.fn(() => pending.promise)
    const cache = createStorageUsageCache({ compute })

    const read = cache.read('/root')
    pending.resolve(usage(10))
    await expect(read).resolves.toEqual(usage(10))
    expect(compute).toHaveBeenCalledTimes(1)
  })

  it('serves a fresh reading without walking the disk again', async () => {
    const compute = vi.fn(async () => usage(20))
    let clock = 1_000
    const cache = createStorageUsageCache({ compute, ttlMs: 60_000, now: () => clock })

    await cache.read('/root')
    clock += 30_000
    await expect(cache.read('/root')).resolves.toEqual(usage(20))
    expect(compute).toHaveBeenCalledTimes(1)
  })

  it('hands back the stale numbers and refreshes them in the background', async () => {
    let total = 30
    const compute = vi.fn(async () => usage(total))
    let clock = 0
    const cache = createStorageUsageCache({ compute, ttlMs: 1_000, now: () => clock })

    await cache.read('/root')
    clock += 5_000
    total = 42

    // The stale read resolves without waiting for the new walk.
    await expect(cache.read('/root')).resolves.toEqual(usage(30))
    expect(compute).toHaveBeenCalledTimes(2)
    await new Promise((resolve) => setTimeout(resolve, 0))
    await expect(cache.read('/root')).resolves.toEqual(usage(42))
  })

  it('never starts a second walk while one is running', async () => {
    const pending = deferred()
    const compute = vi.fn(() => pending.promise)
    const cache = createStorageUsageCache({ compute })

    cache.warm('/root')
    cache.warm('/root')
    cache.warm('/root')
    expect(compute).toHaveBeenCalledTimes(1)
    pending.resolve(usage(7))
    await Promise.resolve()
    await Promise.resolve()
    expect(compute).toHaveBeenCalledTimes(1)
  })

  it('keeps the previous numbers when a walk fails', async () => {
    let fail = false
    const compute = vi.fn(async () => {
      if (fail) throw new Error('disk walk failed')
      return usage(99)
    })
    let clock = 0
    const cache = createStorageUsageCache({ compute, ttlMs: 1_000, now: () => clock })
    await cache.read('/root')

    fail = true
    clock += 5_000
    await expect(cache.read('/root')).resolves.toEqual(usage(99))
    await new Promise((resolve) => setTimeout(resolve, 0))
    await expect(cache.read('/root')).resolves.toEqual(usage(99))
  })

  it('does not serve one root\u2019s numbers for another', async () => {
    const compute = vi.fn(async (root: string) => usage(root === '/a' ? 1 : 2))
    const cache = createStorageUsageCache({ compute })

    await expect(cache.read('/a')).resolves.toEqual(usage(1))
    await expect(cache.read('/b')).resolves.toEqual(usage(2))
    expect(compute).toHaveBeenCalledTimes(2)
  })
})
