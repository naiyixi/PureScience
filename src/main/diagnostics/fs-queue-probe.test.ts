import { afterAll, describe, expect, it } from 'vitest'

import {
  beginFsOperation,
  disposeCanaryFile,
  endFsOperation,
  inFlightFsOperationCount,
  startCanaryRead
} from './fs-queue-probe'

afterAll(async () => {
  await disposeCanaryFile()
})

describe('fs queue probe', () => {
  it('counts in-flight fs operations without going negative', () => {
    const before = inFlightFsOperationCount()
    beginFsOperation()
    beginFsOperation()
    expect(inFlightFsOperationCount()).toBe(before + 2)
    endFsOperation()
    endFsOperation()
    expect(inFlightFsOperationCount()).toBe(before)
    // An unbalanced end must not make the depth negative: the depth is read as a queue reading, and a negative
    // number would silently read as "no contention" to whoever reads the diagnostic.
    endFsOperation()
    expect(inFlightFsOperationCount()).toBe(0)
  })

  it('times a canary read of a file measured in bytes', async () => {
    const first = await startCanaryRead()
    const second = await startCanaryRead()
    expect(Number.isFinite(first)).toBe(true)
    expect(first).toBeGreaterThanOrEqual(0)
    // The canary is 1 KB and page-cached after the first read: it must not itself be slow, otherwise it could
    // not distinguish "the pool is saturated" from "the canary is expensive".
    expect(second).toBeLessThan(250)
  })
})
