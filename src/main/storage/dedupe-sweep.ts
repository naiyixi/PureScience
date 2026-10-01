import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { link, lstat, readdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * One-off tidy-up of content that was already stored twice before the content store existed. It is the same
 * idea as the write-time dedupe, applied to what is already on disk, and it is built to be interruptible:
 * every replacement is a single atomic link-then-rename, so stopping at any point leaves a consistent tree
 * and re-running simply finds less to do. No file is ever removed before its replacement is in place.
 */
export type SweepProgress = { scanned: number; linked: number; bytes: number }

export type SweepResult = SweepProgress & {
  /** Distinct contents found among same-size candidates: hashing decided this, never the size. */
  distinct: number
  /** Files already sharing their bytes with another name, left alone. */
  alreadyShared: number
  /** Same-size candidates whose bytes could not be read, so no claim is made about them. */
  unreadable: number
  /** Verified duplicates whose replacement failed (e.g. cross-device); they were left as they were. */
  unlinked: number
}

const digestOf = async (path: string): Promise<string | undefined> => {
  const hash = createHash('sha256')
  try {
    for await (const chunk of createReadStream(path)) {
      hash.update(chunk as Buffer)
    }
  } catch {
    return undefined
  }
  return hash.digest('hex')
}

type Candidate = { path: string; size: number }

const collect = async (dir: string, into: Candidate[]): Promise<number> => {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  let alreadyShared = 0
  for (const entry of entries) {
    const target = join(dir, entry.name)
    if (entry.isDirectory()) {
      alreadyShared += await collect(target, into)
      continue
    }
    if (!entry.isFile()) continue

    const info = await lstat(target).catch(() => undefined)
    if (!info) continue
    if (info.nlink > 1) {
      // Its bytes are already shared with another name; there is nothing left to reclaim here.
      alreadyShared += 1
      continue
    }
    into.push({ path: target, size: info.size })
  }
  return alreadyShared
}

export const sweepDuplicateContent = async (options: {
  storageRoot: string
  /** Directories under the storage root that hold user content. */
  dirs?: readonly string[]
  onProgress?: (progress: SweepProgress) => void
}): Promise<SweepResult> => {
  const dirs = options.dirs ?? ['uploads', 'artifacts']
  const candidates: Candidate[] = []
  let alreadyShared = 0
  for (const dir of dirs) {
    alreadyShared += await collect(join(options.storageRoot, dir), candidates)
  }

  // Equal size is a necessary condition for equal content, so only same-size files are ever hashed. On a
  // many-gigabyte root this is the difference between reading a handful of files and reading all of them.
  const bySize = new Map<number, Candidate[]>()
  for (const candidate of candidates) {
    const group = bySize.get(candidate.size)
    if (group) group.push(candidate)
    else bySize.set(candidate.size, [candidate])
  }

  const progress: SweepProgress = { scanned: 0, linked: 0, bytes: 0 }
  let distinct = 0
  let unreadable = 0
  let unlinked = 0

  for (const group of bySize.values()) {
    if (group.length < 2) continue
    const seen = new Map<string, string>()

    for (const candidate of group) {
      const digest = await digestOf(candidate.path)
      progress.scanned += 1
      if (!digest) {
        unreadable += 1
        continue
      }

      const firstPath = seen.get(digest)
      if (!firstPath) {
        // First name for these bytes in this size group: this is one distinct content, and it is kept.
        seen.set(digest, candidate.path)
        distinct += 1
        continue
      }

      // A verified duplicate: replace this name with a link to the copy already on disk. The rename is
      // atomic, so a crash leaves either the old file or the new link — never a missing file.
      const temporaryPath = `${candidate.path}.sweep-${randomUUID().slice(0, 8)}`
      try {
        await link(firstPath, temporaryPath)
        await rename(temporaryPath, candidate.path)
        progress.linked += 1
        progress.bytes += candidate.size
      } catch {
        // Cross-device or unsupported: leave the file exactly as it was and move on. Not counted as
        // distinct — the bytes ARE a duplicate, we simply could not link them.
        unlinked += 1
      } finally {
        await rm(temporaryPath, { force: true }).catch(() => undefined)
      }

      options.onProgress?.(progress)
    }
  }

  return { ...progress, distinct, alreadyShared, unreadable, unlinked }
}
