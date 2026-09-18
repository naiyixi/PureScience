import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The acquire path's read segment reported 351 ms for a 21 KB file while the same readFile+sha256 measures a
// median of 0.2 ms from outside the app, with the event loop healthy throughout — which points at queueing on
// a shared resource rather than at the file. readFile uses the libuv threadpool, and this app runs its own fs
// fan-out (51 listFiles calls at startup alone), so the question is whether a read that costs microseconds
// gets slow while an acquire is in flight.
//
// A canary read of a file measured in bytes answers it from inside: if the canary also takes hundreds of ms,
// the shared resource is saturated; if it stays fast, queueing is not the story.
let inFlightFsOperations = 0

const beginFsOperation = (): void => {
  inFlightFsOperations += 1
}

const endFsOperation = (): void => {
  inFlightFsOperations = Math.max(0, inFlightFsOperations - 1)
}

const inFlightFsOperationCount = (): number => inFlightFsOperations

let canaryPath: Promise<string> | undefined

const canaryFile = (): Promise<string> => {
  if (!canaryPath) {
    canaryPath = (async () => {
      const directory = await mkdtemp(join(tmpdir(), 'purescience-fs-canary-'))
      const file = join(directory, 'canary.bin')
      await writeFile(file, Buffer.alloc(1024, 7))
      return file
    })()
  }
  return canaryPath
}

// Started before the operation under measurement and awaited after it: the reading therefore covers the same
// window, which a probe run afterwards would not.
const startCanaryRead = (): Promise<number> => {
  const startedAt = Date.now()
  return canaryFile().then(async (file) => {
    await readFile(file)
    return Date.now() - startedAt
  })
}

// Test and teardown hook: the canary is one small file in the OS temp directory.
const disposeCanaryFile = async (): Promise<void> => {
  const pending = canaryPath
  canaryPath = undefined
  if (!pending) return
  const file = await pending.catch(() => undefined)
  if (file) await rm(file, { force: true }).catch(() => undefined)
}

export {
  beginFsOperation,
  disposeCanaryFile,
  endFsOperation,
  inFlightFsOperationCount,
  startCanaryRead
}
