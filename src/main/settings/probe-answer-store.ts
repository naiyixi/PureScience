// Answers to `--version` probes, kept across processes.
//
// Why this exists: `withVersionProbeCache` removes the repeat spawn inside one process, but the FIRST probe
// of every launch still pays the binary's own startup. Measured on this host (2026-10-24, `opencode
// --version`, the shipped cache implementation): cold **4,035.9 ms**, warm **1.062 ms**. The settings
// preflight asks for that answer on the user's critical path, so a launch-cost-only probe is a 4-second
// wait for something that provably cannot change unless the file changes — the same argument the in-memory
// cache already makes, one lifetime longer.
//
// Freshness is unchanged, and it is the reason the key carries the identity: the key is
// `sha256(executablePath + "\0" + mtimeMs + ":" + size)` — the exact fingerprint the in-memory cache uses.
// A reinstalled or updated binary has a new fingerprint and is probed again; a binary nobody touched is
// answered from disk. Nothing here is a timeout.
//
// Two deliberate refusals, same as the in-memory cache: a failed probe is never written (a spawn failure is
// machine-transient and would otherwise read as "not installed" until the file changed), and a missing or
// corrupt file is ignored rather than treated as an empty answer set.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

const FILE_VERSION = 1

export type ProbeAnswerStore = {
  /** Reads the file once. Safe to call twice; a second call has nothing to do. */
  load: () => Promise<void>
  get: (key: string) => string | undefined
  set: (key: string, version: string) => void
  /** Resolves after every queued write has been attempted. Tests and clean shutdown use it. */
  flush: () => Promise<void>
}

export type ProbeAnswerStoreOptions = {
  filePath: string
  /** Upper bound on remembered answers; the oldest entry is dropped first. */
  maxEntries?: number
  readText?: (path: string) => Promise<string>
  writeText?: (path: string, contents: string) => Promise<void>
}

const DEFAULT_MAX_ENTRIES = 64

const parseEntries = (raw: string): Map<string, string> => {
  const entries = new Map<string, string>()
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return entries
  }
  if (typeof parsed !== 'object' || parsed === null) return entries
  const document = parsed as { version?: unknown; entries?: unknown }
  if (document.version !== undefined && document.version !== FILE_VERSION) return entries
  const stored = document.entries
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return entries
  for (const [key, value] of Object.entries(stored as Record<string, unknown>)) {
    // Only a string can be a version. Anything else is a hand-edited or half-written file, and guessing at
    // it would put an unverified string in front of the user as "the installed version".
    if (typeof value === 'string' && value.length > 0) entries.set(key, value)
  }
  return entries
}

export const createProbeAnswerStore = (options: ProbeAnswerStoreOptions): ProbeAnswerStore => {
  const readText = options.readText ?? ((path: string) => readFile(path, 'utf8'))
  const writeText =
    options.writeText ??
    (async (path: string, contents: string): Promise<void> => {
      await mkdir(dirname(path), { recursive: true })
      // Temp + rename: a half-written answer file would be a corrupt file, and the next launch would throw
      // away every answer it holds.
      const temporary = `${path}.${process.pid}.tmp`
      await writeFile(temporary, contents, 'utf8')
      await rename(temporary, path)
    })
  const maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_ENTRIES)

  const entries = new Map<string, string>()
  let loaded = false
  let pending: Promise<void> = Promise.resolve()

  const persist = (): Promise<void> => {
    const document = JSON.stringify({ version: FILE_VERSION, entries: Object.fromEntries(entries) })
    // Ordered through one chain so two answers written in quick succession cannot interleave their renames.
    pending = pending
      .then(() => writeText(options.filePath, document))
      .catch(() => {
        // A cache that cannot be written is a slower next launch, never a failed one.
      })
    return pending
  }

  return {
    load: async (): Promise<void> => {
      if (loaded) return
      loaded = true
      try {
        const raw = await readText(options.filePath)
        for (const [key, value] of parseEntries(raw)) entries.set(key, value)
        while (entries.size > maxEntries) {
          const oldest = entries.keys().next()
          if (oldest.done === true) break
          entries.delete(oldest.value)
        }
      } catch {
        // No file yet, or unreadable: start empty.
      }
    },
    get: (key: string): string | undefined => entries.get(key),
    set: (key: string, version: string): void => {
      entries.set(key, version)
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next()
        if (oldest.done === true) break
        entries.delete(oldest.value)
      }
      void persist()
    },
    flush: (): Promise<void> => pending
  }
}
