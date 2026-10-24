// Identity-keyed memoisation for executable version probes.
//
// Real evidence, 2026-10-23 (packaged build, one host): `settings:get-preflight` was logged as a slow
// IPC handler 35 times in one afternoon, median 14.0 s / max 35.1 s, and `settings:check-environment`
// 9 times at a 28.7 s median. Every one of those calls re-runs the SAME `<binary> --version` spawns
// against the SAME files: nothing about a probe's answer can change between two calls unless the file
// itself changed. The measurements also happened on a host where the process held 7.7 % of the CPU and
// the load average reached 165 (`diagnostics` stall records, `cpuShare: 0.077`), i.e. what changes
// between runs is machine-side, not product-side. Removing work that provably cannot produce a
// different answer is therefore the part that is safe to optimise now, and the only part: with the
// answer keyed on the file's identity, a repeat call costs one `stat` instead of a process spawn.
//
// Freshness rule, not a timeout: the answer is reused only while the executable's `mtimeMs` + `size`
// are unchanged. A binary that is reinstalled in place has a new mtime, so it is probed again — the
// window for a stale answer is not "60 seconds", it is "the file changed without changing mtime or
// size", which the filesystem does not produce.
//
// Two things this deliberately does NOT do:
//   * It never caches a failed probe. A probe returns `undefined` both when the binary cannot answer
//     `--version` and when the spawn itself failed — and spawn failures here are machine-transient
//     (timeouts under load). Caching that would surface "not installed" for an installed runtime until
//     the file changes. Failures are retried; only answered probes are remembered.
//   * It never treats a missing file as proof of anything on Windows, where a version probe runs
//     through a shell and `PATH`/`PATHEXT` may resolve a name the raw path does not have. On Windows a
//     missing `stat` degrades to "unknown" (probe anyway, remember nothing); on POSIX a missing file
//     has no version to report, so the spawn is skipped.

import { stat } from 'node:fs/promises'

import type { ProbeAnswerStore } from './probe-answer-store'

export type VersionProbe = (executablePath: string) => Promise<string | undefined>

/**
 * What the cache is allowed to conclude about an executable:
 * - `present`: the file (or the target of its symlink) exists with this identity;
 * - `missing`: the path holds no file that could answer a version probe;
 * - `unknown`: identity could not be established — probe, but remember nothing.
 */
export type ExecutableIdentity =
  { kind: 'present'; identity: string } | { kind: 'missing' } | { kind: 'unknown' }

export type VersionProbeCacheOptions = {
  /** Injectable identity source so the cache is testable without real files. */
  identify?: (executablePath: string) => Promise<ExecutableIdentity>
  /** Upper bound on remembered answers. Older entries are evicted first. */
  maxEntries?: number
}

const DEFAULT_MAX_ENTRIES = 64

// A store that outlives the process. Configured once at startup, deliberately module-level: the probe
// wrappers are built by each detect module's own factory (`createDefaultDetectDeps()`), and threading a
// store through five factories to reach one file would be five chances to forget it in a sixth.
let processAnswerStore: ProbeAnswerStore | undefined

export const configureVersionProbeAnswerStore = (store: ProbeAnswerStore | undefined): void => {
  processAnswerStore = store
}

const errnoOf = (error: unknown): string | undefined => {
  if (typeof error !== 'object' || error === null) return undefined
  const code = (error as NodeJS.ErrnoException).code
  return typeof code === 'string' ? code : undefined
}

// `stat` follows symlinks, which is what a version probe does too: `--version` is answered by the
// bytes the link resolves to, so the target's identity is the one that matters.
export const identifyExecutable = async (
  executablePath: string,
  platform: NodeJS.Platform = process.platform
): Promise<ExecutableIdentity> => {
  try {
    const info = await stat(executablePath)
    return { kind: 'present', identity: `${info.mtimeMs}:${info.size}` }
  } catch (error) {
    const code = errnoOf(error)
    const absent = code === 'ENOENT' || code === 'ENOTDIR'
    // See the header: a shell-resolved probe on Windows can still answer for a path `stat` cannot see.
    if (absent) return platform === 'win32' ? { kind: 'unknown' } : { kind: 'missing' }
    return { kind: 'unknown' }
  }
}

const cacheKey = (executablePath: string, identity: string): string =>
  `${executablePath}\u0000${identity}`

/**
 * Wraps one version probe with identity-keyed memoisation plus single-flight: concurrent callers for
 * the same executable and identity share one spawn.
 */
export const withVersionProbeCache = (
  probe: VersionProbe,
  options: VersionProbeCacheOptions = {}
): VersionProbe => {
  const identify = options.identify ?? ((path: string) => identifyExecutable(path))
  const maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_ENTRIES)

  const answered = new Map<string, string>()
  const inFlight = new Map<string, Promise<string | undefined>>()

  const remember = (key: string, version: string): void => {
    answered.set(key, version)
    while (answered.size > maxEntries) {
      const oldest = answered.keys().next()
      if (oldest.done === true) break
      answered.delete(oldest.value)
    }
  }

  return async (executablePath: string): Promise<string | undefined> => {
    let identity: ExecutableIdentity
    try {
      identity = await identify(executablePath)
    } catch {
      identity = { kind: 'unknown' }
    }

    if (identity.kind === 'missing') return undefined
    if (identity.kind === 'unknown') return probe(executablePath)

    const key = cacheKey(executablePath, identity.identity)
    const remembered = answered.get(key)
    if (remembered !== undefined) return remembered

    // Answered by a previous process: same fingerprint, so the spawn contributed nothing but startup time.
    const persisted = processAnswerStore?.get(key)
    if (persisted !== undefined) {
      remember(key, persisted)
      return persisted
    }

    const pending = inFlight.get(key)
    if (pending !== undefined) return pending

    const run = (async (): Promise<string | undefined> => {
      try {
        const version = await probe(executablePath)
        // Failures are not answers: see the header.
        if (version !== undefined) {
          remember(key, version)
          processAnswerStore?.set(key, version)
        }
        return version
      } finally {
        inFlight.delete(key)
      }
    })()

    inFlight.set(key, run)
    return run
  }
}
