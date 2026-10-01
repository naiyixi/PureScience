import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { link, lstat, mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Content-addressed storage, kept deliberately small: identical bytes get one inode in the storage root and
 * every other name for them is a hard link. There is no reference-count table because a hard link already is
 * the reference — the inode lives while any name does, so deleting one upload cannot strand or corrupt another.
 */
const CONTENT_DIR = '.content'

export type ContentInstallOutcome =
  /** The bytes were already on disk: this path is now another name for them. */
  | 'linked'
  /** First arrival of these bytes: they gained a canonical name (no second copy was made). */
  | 'registered'
  /** Cross-device or no hard-link support. The file is untouched and we say so instead of claiming a dedupe. */
  | 'unavailable'

/** Streaming digest, so a multi-gigabyte upload is never read into memory. */
export const digestOfFile = async (path: string): Promise<string> => {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer)
  }
  return hash.digest('hex')
}

/**
 * Installs `path` as content. The first copy of a digest simply gains a second name under the content
 * directory (zero extra bytes); a later copy of the same bytes is replaced by a link to the copy already on
 * disk (its own bytes are reclaimed). Replacement goes through link-then-rename so the path is never briefly
 * missing: a crash leaves either the old file or the new link, never a hole.
 */
export const installContent = async (options: {
  path: string
  storageRoot: string
}): Promise<ContentInstallOutcome> => {
  const digest = await digestOfFile(options.path).catch(() => undefined)
  if (!digest) return 'unavailable'

  const contentRoot = join(options.storageRoot, CONTENT_DIR)
  const contentPath = join(contentRoot, digest)

  try {
    await mkdir(contentRoot, { recursive: true })
    const canonical = await lstat(contentPath).catch(() => undefined)

    if (!canonical) {
      await link(options.path, contentPath)
      return 'registered'
    }

    const own = await lstat(options.path)
    if (own.dev === canonical.dev && own.ino === canonical.ino) return 'registered'

    const temporaryPath = `${options.path}.content-${randomUUID().slice(0, 8)}`
    try {
      await link(contentPath, temporaryPath)
      await rename(temporaryPath, options.path)
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined)
    }
    return 'linked'
  } catch {
    // A filesystem without hard links (or another device) is not a failure of the app: it is a reason to
    // report that these bytes were not deduplicated. Claiming otherwise would make the space report lie.
    return 'unavailable'
  }
}

/**
 * Removes canonical names nothing else points at. A canonical file whose link count is 1 is the only name for
 * its content, which means every upload that used it is gone — the content is unreachable and can be dropped.
 * Anything still referenced (count ≥ 2) is left alone by construction.
 */
export const pruneUnreferencedContent = async (options: {
  storageRoot: string
}): Promise<{ removed: number; bytes: number }> => {
  const contentRoot = join(options.storageRoot, CONTENT_DIR)
  let removed = 0
  let bytes = 0

  const entries = await readdir(contentRoot).catch(() => [])
  for (const entry of entries) {
    const target = join(contentRoot, entry)
    const info = await lstat(target).catch(() => undefined)
    if (!info || !info.isFile()) continue
    if (info.nlink > 1) continue

    await rm(target, { force: true }).catch(() => undefined)
    removed += 1
    bytes += info.size
  }

  return { removed, bytes }
}

/**
 * Measured, not estimated: every number here comes from the filesystem. `totalBytes` counts each name's
 * size, `uniqueBytes` counts each inode once, so the difference is exactly what sharing saved.
 */
export const measureSpace = async (options: {
  storageRoot: string
  ignores?: string[]
}): Promise<{ uniqueBytes: number; totalBytes: number; files: number; linkedFiles: number }> => {
  const seen = new Set<string>()
  let uniqueBytes = 0
  let totalBytes = 0
  let files = 0
  let linkedFiles = 0
  const ignores = new Set(options.ignores ?? [])

  const walk = async (current: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (ignores.has(entry.name)) continue
      const target = join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(target)
        continue
      }
      if (!entry.isFile()) continue

      const info = await stat(target).catch(() => undefined)
      if (!info) continue

      files += 1
      totalBytes += info.size
      if (info.nlink > 1) linkedFiles += 1

      const identity = `${String(info.dev)}:${String(info.ino)}`
      if (seen.has(identity)) continue
      seen.add(identity)
      uniqueBytes += info.size
    }
  }

  await walk(options.storageRoot)
  return { uniqueBytes, totalBytes, files, linkedFiles }
}
