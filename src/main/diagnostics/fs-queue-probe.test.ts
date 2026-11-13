import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'

import {
  beginFsOperation,
  createFsCanary,
  disposeCanaryFile,
  endFsOperation,
  inFlightFsOperationCount,
  startCanaryRead
} from './fs-queue-probe'

afterAll(async () => {
  await disposeCanaryFile()
})

// Each case gets its own temp root so one case's leftovers cannot answer another's reading.
const roots: string[] = []
const makeRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'purescience-fs-probe-test-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop()
    if (root) await rm(root, { recursive: true, force: true })
  }
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
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(Number.isFinite(first.canaryMs)).toBe(true)
    expect(first.canaryMs).toBeGreaterThanOrEqual(0)
    // The canary is 1 KB and page-cached after the first read: it must not itself be slow, otherwise it could
    // not distinguish "the pool is saturated" from "the canary is expensive".
    expect(second.canaryMs).toBeLessThan(250)
  })

  // The shipped 2.26.0 defect, in one case: the canary's path was memoised as a promise, so a rejected creation
  // was handed to every later reading for the life of the process. The field shape was a permanent transition
  // (66 measured, then 69 unavailable with no recovery across 659 stall records), and it cost the fs half of
  // every stall verdict. A failure must cost exactly one reading.
  it('recovers on the next reading after the temp file disappears', async () => {
    const root = await makeRoot()
    const canary = createFsCanary({ root })

    expect((await canary.startCanaryRead()).ok).toBe(true)
    const [directory] = await readdir(root)
    expect(directory).toBeDefined()
    if (!directory) return
    await rm(join(root, directory, 'canary.bin'))

    const afterPurge = await canary.startCanaryRead()
    expect(afterPurge.ok).toBe(true)
    // And the next one keeps working: the recovery has to be durable, not a one-off.
    expect((await canary.startCanaryRead()).ok).toBe(true)
    await canary.dispose()
  })

  it('does not memoise a failed creation — a later reading tries again and succeeds', async () => {
    const root = await makeRoot()
    const canary = createFsCanary({ root: join(root, 'not-created-yet') })

    // A root that does not exist answers with a named reason instead of an opaque rejection: "the temp directory
    // was gone" and "the pool was busy" must not read the same.
    expect(await canary.startCanaryRead()).toEqual({ ok: false, reason: 'missing' })

    // The very next attempt is a new one. Before the fix the rejected promise stayed cached and this answered
    // `unavailable` for the rest of the process's life.
    await mkdir(join(root, 'not-created-yet'))
    const recovered = await canary.startCanaryRead()
    expect(recovered.ok).toBe(true)
    if (recovered.ok) expect(recovered.canaryMs).toBeGreaterThanOrEqual(0)
    await canary.dispose()
  })
})
