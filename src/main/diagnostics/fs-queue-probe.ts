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
//
// Why the reading is a value, not a thrown error (2026-11-14, shipped-build evidence). The canary used to answer
// `Promise<number>` and reject on failure, while its file path was memoised as a promise — and that memo kept a
// *rejected* promise. One transient failure (the OS purging TMPDIR, a full disk, EMFILE) then turned every later
// reading into the same rejection for the life of the process, and the caller threw the reason away. In the
// shipped 2.26.0 log the shape is a permanent transition: `PureScience/main.log` holds 659 stall records; its
// earlier instance was `fs canary unavailable` on all 523 of its records, and its later instance measured 66 in
// a row up to 2026-11-12T19:55:50Z and then 69 consecutive `unavailable` from 20:12:13Z with no recovery.
// 592 of 659 readings (89.8 %) were lost this way, and with them the fs half of each stall verdict —
// `stall-cause` degrades to `unmeasured` when the canary is missing, which is 550 of those 659 records.
//
// So: a failed canary is a named reading (`{ ok: false, reason }`), a failed *creation* is never memoised, and a
// path that vanished (a temp file an OS cleaned up) is re-created once inside the same call instead of costing
// that stall its measurement.
let inFlightFsOperations = 0

const beginFsOperation = (): void => {
  inFlightFsOperations += 1
}

const endFsOperation = (): void => {
  inFlightFsOperations = Math.max(0, inFlightFsOperations - 1)
}

const inFlightFsOperationCount = (): number => inFlightFsOperations

/** Why the canary could not be read. Closed on purpose: it ends up in a log line and a support bundle. */
export type FsCanaryFailure = 'missing' | 'denied' | 'unavailable'

export type FsCanaryRead = { ok: true; canaryMs: number } | { ok: false; reason: FsCanaryFailure }

export type FsCanary = {
  startCanaryRead: () => Promise<FsCanaryRead>
  dispose: () => Promise<void>
}

const failureOf = (error: unknown): FsCanaryFailure => {
  const code = (error as { code?: unknown } | undefined)?.code
  if (code === 'ENOENT') return 'missing'
  if (code === 'EACCES' || code === 'EPERM') return 'denied'
  return 'unavailable'
}

export const createFsCanary = (options: { now?: () => number; root?: string } = {}): FsCanary => {
  const now = options.now ?? ((): number => Date.now())
  // The temp root is a seam for tests only; production leaves it at the OS temp directory.
  const root = options.root ?? tmpdir()
  // Only a successful creation is kept. A rejected promise left here would be handed to every later caller –
  // that is the defect the header describes.
  let canaryPath: Promise<string> | undefined

  const path = (): Promise<string> => {
    if (!canaryPath) {
      const pending = (async (): Promise<string> => {
        const directory = await mkdtemp(join(root, 'purescience-fs-canary-'))
        const file = join(directory, 'canary.bin')
        await writeFile(file, Buffer.alloc(1024, 7))
        return file
      })()
      canaryPath = pending
      // Clearing only while this attempt is still the memoised one keeps a slow first attempt from erasing a
      // newer one's path.
      pending.catch((): void => {
        if (canaryPath === pending) canaryPath = undefined
      })
    }
    return canaryPath
  }

  // Started before the operation under measurement and awaited after it: the reading therefore covers the same
  // window, which a probe run afterwards would not.
  const startCanaryRead = async (): Promise<FsCanaryRead> => {
    const startedAt = now()
    let file: string
    try {
      file = await path()
    } catch (error) {
      return { ok: false, reason: failureOf(error) }
    }
    try {
      await readFile(file)
      return { ok: true, canaryMs: now() - startedAt }
    } catch (error) {
      const reason = failureOf(error)
      // A temp file removed under us is not a pool reading either: rebuild it once, then report. One retry keeps
      // a genuinely broken temp directory to a single call.
      if (reason !== 'missing') return { ok: false, reason }
      canaryPath = undefined
      try {
        await readFile(await path())
        return { ok: true, canaryMs: now() - startedAt }
      } catch (retryError) {
        return { ok: false, reason: failureOf(retryError) }
      }
    }
  }

  const dispose = async (): Promise<void> => {
    const pending = canaryPath
    canaryPath = undefined
    if (!pending) return
    const file = await pending.catch(() => undefined)
    if (file) await rm(file, { force: true }).catch(() => undefined)
  }

  return { startCanaryRead, dispose }
}

// The process-wide canary: one temp file, created on first use and reused for every reading.
const sharedCanary = createFsCanary()

const startCanaryRead = (): Promise<FsCanaryRead> => sharedCanary.startCanaryRead()

// Test and teardown hook: the canary is one small file in the OS temp directory.
const disposeCanaryFile = (): Promise<void> => sharedCanary.dispose()

export {
  beginFsOperation,
  disposeCanaryFile,
  endFsOperation,
  inFlightFsOperationCount,
  startCanaryRead
}
