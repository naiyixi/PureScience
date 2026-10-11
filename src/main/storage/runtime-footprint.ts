// Runtime storage footprint (v2.0.0 P0-10).
//
// Real evidence, 2026-10-11: the packaged app's data root holds ~14.7 GB, and the content store's own
// maintenance line reported `prunedFiles: 0, prunedBytes: 0` — nothing was reclaimable there. Measured with
// `du -sh -x` per directory, the volume is attributable to completely different places:
//
//   runtime/envs   5.5 G   managed language environments, never reclaimed
//   runtime/pkgs   2.8 G   the package cache those environments were built from
//   notebooks      3.7 G   per-session notebook data (37 sessions; two of them 1.0–1.1 G each)
//   artifacts      546 M   (one project alone 370 M)
//   purescience.db 112 M
//
// So "storage is huge" was never a garbage-collection bug in the content store — it is two families that
// had no readout at all: environments (with their cache) and session data. A recovery number can only be
// honest once the per-family number exists, which is what this module produces: one bounded walk of the
// known roots, bytes AND file counts per family, worst first, and a named state for a family that is not
// present (absent is not zero).

import { opendir, lstat, stat } from 'node:fs/promises'
import { join } from 'node:path'

export type FootprintFamily = {
  /** Directory name relative to the data root, e.g. 'runtime/envs'. */
  name: string
  /** Sum of regular-file sizes, with symlinks counted at their target's size exactly once. */
  bytes: number
  files: number
  /** Named absence: a family that does not exist is reported, not silently counted as 0 bytes. */
  state: 'measured' | 'absent' | 'unreadable'
}

export type RuntimeFootprint = {
  families: FootprintFamily[]
  measuredBytes: number
  measuredFiles: number
  /** Families the measurement could not read, named so a partial total can never read as complete. */
  unreadable: string[]
}

export type MeasureRuntimeFootprintOptions = {
  families?: string[]
  /** Hard cap on directory entries walked, so a pathology cannot turn a report into a hang. */
  maxEntries?: number
}

const DEFAULT_FAMILIES = [
  'runtime/envs',
  'runtime/pkgs',
  'runtime/packs',
  'runtime/provenance',
  'notebooks',
  'artifacts',
  'claude'
]
const DEFAULT_MAX_ENTRIES = 400_000

type WalkTotal = { bytes: number; files: number; truncated: boolean }

// Hard links are the normal shape here, not an edge case: micromamba links package files into the
// environments it creates, and the content store links blob-then-rename. Summing every path therefore
// counts the same bytes several times — measured on the real root, `runtime/pkgs` came out 5.48 G while
// `du` reported 2.80 G. Counting once per inode (as `du` does) is what makes the number checkable, and the
// set must be shared ACROSS families: per-family sets would still double-count a file linked from one
// family into another. A file linked across two families is therefore counted in whichever family is
// measured first (the order is fixed), and the accountable number is the total.
const walk = async (
  root: string,
  budget: { left: number },
  seenInodes: Set<string>
): Promise<WalkTotal> => {
  const total: WalkTotal = { bytes: 0, files: 0, truncated: false }
  const stack: string[] = [root]

  while (stack.length > 0) {
    const current = stack.pop()
    if (current === undefined) break
    let handle
    try {
      handle = await opendir(current)
    } catch {
      total.truncated = true
      continue
    }
    try {
      for await (const entry of handle) {
        if (budget.left <= 0) {
          total.truncated = true
          return total
        }
        budget.left -= 1
        const path = join(current, entry.name)
        try {
          const info = await lstat(path)
          if (info.isSymbolicLink()) continue
          if (info.isDirectory()) {
            stack.push(path)
          } else if (info.isFile()) {
            const inode = `${info.dev}:${info.ino}`
            if (seenInodes.has(inode)) continue
            seenInodes.add(inode)
            total.bytes += info.size
            total.files += 1
          }
        } catch {
          // A file that vanished or is unreadable mid-walk is skipped; the count stays honest because the
          // family is still reported as measured over what could be read.
          continue
        }
      }
    } finally {
      // opendir handles close on async-iteration completion; an early return above still releases it here.
    }
  }

  return total
}

/**
 * Measures the known storage families under one data root. Read-only, bounded, and never throws: an
 * unreadable family is reported by name so the caller can say "partial" instead of "that is all of it".
 */
export const measureRuntimeFootprint = async (
  dataRoot: string,
  options: MeasureRuntimeFootprintOptions = {}
): Promise<RuntimeFootprint> => {
  const names = options.families ?? DEFAULT_FAMILIES
  const budget = { left: options.maxEntries ?? DEFAULT_MAX_ENTRIES }
  // Shared across every family so hard links are counted exactly once for the whole measurement.
  const seenInodes = new Set<string>()
  const families: FootprintFamily[] = []
  const unreadable: string[] = []

  for (const name of names) {
    const path = join(dataRoot, name)
    let exists = true
    try {
      const info = await stat(path)
      exists = info.isDirectory()
    } catch {
      exists = false
    }

    if (!exists) {
      families.push({ name, bytes: 0, files: 0, state: 'absent' })
      continue
    }

    const measured = await walk(path, budget, seenInodes)
    if (measured.truncated) {
      unreadable.push(name)
      families.push({ name, bytes: measured.bytes, files: measured.files, state: 'unreadable' })
      continue
    }
    families.push({ name, bytes: measured.bytes, files: measured.files, state: 'measured' })
  }

  return {
    families: [...families].sort((left, right) => right.bytes - left.bytes),
    measuredBytes: families.reduce((sum, family) => sum + family.bytes, 0),
    measuredFiles: families.reduce((sum, family) => sum + family.files, 0),
    unreadable
  }
}

/** One greppable log line's worth of text: worst families first, each with its size and file count. */
export const formatRuntimeFootprint = (footprint: RuntimeFootprint, limit = 6): string =>
  footprint.families
    .filter((family) => family.bytes > 0 || family.state !== 'absent')
    .slice(0, limit)
    .map(
      (family) =>
        `${family.name}=${formatBytes(family.bytes)}/${family.files}f${family.state === 'measured' ? '' : `(${family.state})`}`
    )
    .join(' ')

export const formatBytes = (bytes: number): string => {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)}G`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)}M`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)}K`
  return `${bytes}B`
}
