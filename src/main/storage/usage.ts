import { lstat, readdir, stat, statfs, unlink } from 'node:fs/promises'
import { join } from 'node:path'

import { logicalEnvNameFromDirectory } from '../notebook/runtime-paths'

export type UsageCategoryKey = 'artifacts' | 'uploads' | 'runtime' | 'notebooks' | 'workspaces'
export type UsageChild = { name: string; bytes: number }
export type UsageCategory = { key: UsageCategoryKey; bytes: number; children?: UsageChild[] }
// One definition, shared with the renderer: the reading crosses IPC, so a `pending` flag added on one side only
// would compile here and be dropped at the boundary.
import type { SharedBytes, StorageUsage } from '../../shared/storage'
export type { StorageUsage }

const CATEGORY_KEYS: UsageCategoryKey[] = [
  'artifacts',
  'uploads',
  'runtime',
  'notebooks',
  'workspaces'
]

// Recursively sums UNIQUE file sizes under `dir`, deduping hard links by (dev, ino) through `seen`
// (like `du`): a file whose inode was already counted contributes 0. This is essential for the runtime
// dir — conda envs are hard-linked from the shared pkgs cache, so without dedup the same bytes get
// counted in both `conda` and each env, roughly doubling the reported total. Callers that want
// independent buckets pass their own fresh `seen`; the runtime breakdown shares ONE `seen` across
// conda+envs so the shared inodes are attributed to conda (counted first) and not re-counted per env.
// Missing dirs contribute 0; symlinks are skipped (not followed) to avoid cycles and double-counting.
//
// P0-10 (last open item): "we could not look" and "there was nothing" must not read alike wherever the
// number is REPORTED — as bytes a removal recovered, or as the size of an environment prefix. The failure
// policy is therefore an explicit parameter of the ONE traversal rather than a second walker: `dirSize`
// keeps counting an unreadable directory as 0 (its callers total a whole tree, where one unreadable
// subdirectory must not blank the category), while `measureDirectorySize` answers with a reading or with a
// named reason why there is none.
type UnreadableDirectoryPolicy = 'count-as-zero' | 'report'

// A path that is not there holds nothing. That IS a measurement, and it is 0 — unlike a directory that
// exists but cannot be listed (permissions, I/O), which is not a reading at all.
const isMissingPath = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'

const walkDirectorySize = async (
  dir: string,
  seen: Set<string>,
  shared: SharedBytes | undefined,
  unreadable: UnreadableDirectoryPolicy
): Promise<number> => {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    if (isMissingPath(error) || unreadable === 'count-as-zero') return 0
    throw error
  }
  let total = 0
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      total += await walkDirectorySize(path, seen, shared, unreadable)
    } else if (entry.isFile()) {
      total += await fileSize(path, seen, shared)
    }
  }
  return total
}

export const dirSize = async (
  dir: string,
  seen: Set<string>,
  shared?: SharedBytes
): Promise<number> => walkDirectorySize(dir, seen, shared, 'count-as-zero')

// Two states, named the way the rest of the app names a missing reading (`reading-journal.ts`): a number
// that was measured, or `unavailable`/`unreadable` — never a fabricated 0.
export type DirectorySizeMeasurement =
  { state: 'measured'; bytes: number } | { state: 'unavailable'; reason: 'unreadable' }

export const measureDirectorySize = async (
  dir: string,
  seen: Set<string>,
  shared?: SharedBytes
): Promise<DirectorySizeMeasurement> => {
  try {
    return { state: 'measured', bytes: await walkDirectorySize(dir, seen, shared, 'report') }
  } catch {
    return { state: 'unavailable', reason: 'unreadable' }
  }
}

// Size of one file, or 0 if its inode was already counted via `seen` (hard-link dedup). The skipped size is
// accumulated into `shared` so the panel can state what sharing saved instead of only the smaller total.
const fileSize = async (path: string, seen: Set<string>, shared?: SharedBytes): Promise<number> => {
  const info = await stat(path).catch(() => undefined)
  if (!info) return 0
  const key = `${info.dev}:${info.ino}`
  if (seen.has(key)) {
    if (shared) {
      shared.bytes += info.size
      shared.files += 1
    }
    return 0
  }
  seen.add(key)
  return info.size
}

// Breaks the runtime dir into meaningful buckets for the Storage panel: `conda` (the shared package
// cache + micromamba root) and one child per conda env under envs/ — with default-python/default-r
// surfaced as `python`/`r` and named envs shown by their name. Sorted descending by bytes; each
// subtree is recursed once. This is why the panel shows conda | python | r rather than one opaque lump.
const RUNTIME_INFRA_DIRS = ['pkgs', 'micromamba']
const ENV_LABELS: Record<string, string> = { 'default-python': 'python', 'default-r': 'r' }
// Transient relocation staging (exported @EXPLICIT locks, consumed by the startup restore). Counted
// toward the runtime total for accuracy, but not surfaced as its own row — it's app plumbing, not
// user data, and is usually 0 B after restore.
const RUNTIME_HIDDEN_DIRS = ['envs.lock']

const runtimeUsage = async (
  dir: string,
  shared?: SharedBytes
): Promise<{ bytes: number; children: UsageChild[] }> => {
  const children: UsageChild[] = []
  let looseBytes = 0
  // ONE dedup set across conda + every env: conda is scanned first, so the shared package inodes are
  // attributed to conda and the envs (hard-linked from it) report only their own unique bytes — the
  // sum then matches `du` of the runtime dir instead of double-counting the cache.
  const seen = new Set<string>()

  // conda infrastructure: shared package cache (pkgs) + any downloaded micromamba root.
  let condaBytes = 0
  for (const infra of RUNTIME_INFRA_DIRS)
    condaBytes += await dirSize(join(dir, infra), seen, shared)
  if (condaBytes > 0) children.push({ name: 'conda', bytes: condaBytes })

  // one child per environment under envs/ (default-python/-r -> python/r, others by name).
  let envEntries
  try {
    envEntries = await readdir(join(dir, 'envs'), { withFileTypes: true })
  } catch {
    envEntries = []
  }
  const envBytes = new Map<string, number>()
  for (const entry of envEntries) {
    if (entry.isSymbolicLink() || !entry.isDirectory()) continue
    const logicalName = logicalEnvNameFromDirectory(entry.name)
    const label = ENV_LABELS[logicalName] ?? logicalName
    const bytes = await dirSize(join(dir, 'envs', entry.name), seen, shared)
    envBytes.set(label, (envBytes.get(label) ?? 0) + bytes)
  }
  for (const [name, bytes] of envBytes) children.push({ name, bytes })

  // loose top-level files (e.g. .env-ready) and any other top-level dirs, so the total stays exact.
  let topEntries
  try {
    topEntries = await readdir(dir, { withFileTypes: true })
  } catch {
    return { bytes: 0, children: [] }
  }
  for (const entry of topEntries) {
    if (entry.isSymbolicLink()) continue
    if (entry.isFile()) {
      looseBytes += await fileSize(join(dir, entry.name), seen)
    } else if (
      entry.isDirectory() &&
      entry.name !== 'envs' &&
      !RUNTIME_INFRA_DIRS.includes(entry.name)
    ) {
      const bytes = await dirSize(join(dir, entry.name), seen, shared)
      // Hidden plumbing (e.g. envs.lock) counts toward the total but is not shown as its own row.
      if (RUNTIME_HIDDEN_DIRS.includes(entry.name)) looseBytes += bytes
      else children.push({ name: entry.name, bytes })
    }
  }

  children.sort((a, b) => b.bytes - a.bytes)
  const bytes = looseBytes + children.reduce((sum, child) => sum + child.bytes, 0)
  return { bytes, children }
}

// What the SHARED package cache holds that is provably redundant (v2.0.0 P0-10).
//
// Real evidence, 2026-10-11: the data root carries `runtime/pkgs` at 2.8 GB, and nothing in the app ever
// reclaims it (`micromamba-cache.ts:211` only removes a directory that same call had created and then
// rejected) — so the cache only grows. But reclaiming it blindly is not safe either: micromamba
// HARD-LINKS package files into the environments it builds, so a cache path and an env path are two names
// for one inode. Removing the cache name is data-safe exactly when another link exists; a file whose link
// count is 1 is the last name for its bytes.
//
// This is the reading that a reclamation has to be built on, so it is measured BEFORE anything is deleted:
// bytes whose cache copy has another link (provably redundant), and bytes that exist once (last link —
// deleting those would destroy data). `maxLinkCount` is kept as the evidence behind the split: it is the
// link count actually observed, not a claim about what the numbers mean.
export type PackageCacheRedundancy = {
  redundantBytes: number
  redundantFiles: number
  soleLinkBytes: number
  soleLinkFiles: number
  maxLinkCount: number
}

export const measurePackageCacheRedundancy = async (
  dataRoot: string
): Promise<PackageCacheRedundancy> => {
  const pkgsDir = join(dataRoot, 'runtime', 'pkgs')
  const result: PackageCacheRedundancy = {
    redundantBytes: 0,
    redundantFiles: 0,
    soleLinkBytes: 0,
    soleLinkFiles: 0,
    maxLinkCount: 0
  }
  const walk = async (dir: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(path)
        continue
      }
      if (!entry.isFile()) continue
      let info
      try {
        info = await lstat(path)
      } catch {
        continue
      }
      result.maxLinkCount = Math.max(result.maxLinkCount, info.nlink)
      if (info.nlink > 1) {
        result.redundantBytes += info.size
        result.redundantFiles += 1
      } else {
        result.soleLinkBytes += info.size
        result.soleLinkFiles += 1
      }
    }
  }
  await walk(pkgsDir)
  return result
}

// The reclaim action built on the reading above: removes the cache names whose bytes another link still
// holds. The rule is deliberately one-sided — a file whose link count is 1 is NEVER touched, because that
// name is the last one for its bytes and removing it would destroy data the reading does not claim to
// understand. Link count is re-checked at delete time (not trusted from the earlier walk), and the freed
// size is summed from the files actually removed, so "freed N" is a count of what happened, not an estimate.
export type PackageCacheReclaim = {
  freedBytes: number
  freedFiles: number
  /** Last-link files left exactly as they were: the sizes the action refused to touch. */
  leftAloneBytes: number
  leftAloneFiles: number
  /** Files that could not be inspected/removed mid-walk; nothing is claimed about them. */
  skippedFiles: number
  elapsedMs: number
}

export const reclaimRedundantPackageCache = async (
  dataRoot: string
): Promise<PackageCacheReclaim> => {
  const pkgsDir = join(dataRoot, 'runtime', 'pkgs')
  const startedAt = Date.now()
  const result: PackageCacheReclaim = {
    freedBytes: 0,
    freedFiles: 0,
    leftAloneBytes: 0,
    leftAloneFiles: 0,
    skippedFiles: 0,
    elapsedMs: 0
  }

  const walk = async (dir: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(path)
        continue
      }
      if (!entry.isFile()) continue
      try {
        const before = await lstat(path)
        if (before.nlink <= 1) {
          result.leftAloneBytes += before.size
          result.leftAloneFiles += 1
          continue
        }
        await unlink(path)
        result.freedBytes += before.size
        result.freedFiles += 1
      } catch {
        result.skippedFiles += 1
      }
    }
  }

  await walk(pkgsDir)
  result.elapsedMs = Date.now() - startedAt
  return result
}

export const computeStorageUsage = async (
  dataRoot: string,
  projects?: { id: string; name?: string }[]
): Promise<StorageUsage> => {
  const categories: UsageCategory[] = []
  // One accumulator for the whole walk. Every hard link that spares a second count adds its size here, so
  // the panel can say what sharing saved — a number read off the same walk, not a claim about dedup.
  const shared: SharedBytes = { bytes: 0, files: 0 }
  for (const key of CATEGORY_KEYS) {
    const dir = join(dataRoot, key)
    if (key === 'runtime') {
      const { bytes, children } = await runtimeUsage(dir, shared)
      categories.push({ key, bytes, children })
    } else {
      // Independent bucket: its own dedup set (no hard links cross data-category boundaries).
      categories.push({ key, bytes: await dirSize(dir, new Set(), shared) })
    }
  }
  const totalBytes = categories.reduce((sum, c) => sum + c.bytes, 0)
  // Per-project rows, computed ONLY when the caller names the projects (the walk itself stays directory-only:
  // this module has no database dependency and does not grow one). A project's space is what its notebook runs
  // and its artifacts occupy; each project gets its own dedup set, since links do not cross project boundaries.
  const projectRows = projects?.length
    ? (
        await Promise.all(
          projects.map(async (project) => ({
            id: project.id,
            name: project.name,
            bytes:
              (await dirSize(join(dataRoot, 'notebooks', project.id), new Set()).catch(() => 0)) +
              (await dirSize(join(dataRoot, 'artifacts', project.id), new Set()).catch(() => 0))
          }))
        )
      ).sort((a, b) => b.bytes - a.bytes)
    : undefined
  return {
    categories,
    totalBytes,
    sharedBytes: shared.bytes,
    sharedFiles: shared.files,
    ...(projectRows ? { projects: projectRows } : {})
  }
}

export const availableBytes = async (targetPath: string): Promise<number> => {
  const stats = await statfs(targetPath)
  return stats.bavail * stats.bsize
}
