// A bounded memo for interpreter probes — the one part of environment discovery that costs a subprocess.
//
// Why this exists (real readings, 2026-11-02). `notebook:list-runtimes` re-runs discovery on every read,
// and discovery asks each interpreter for its version (`<interp> --version`, plus one `Rscript` start for
// R to see whether jsonlite is there). On this machine's own data root that is 28 python interpreters in
// 196 ms cold, and the packaged app's log shows the same handler at a **3,777 ms median over 66 calls**
// (max 21,926 ms) — a machine under memory pressure pays ~20x per spawn. 37 of the 65 gaps between
// consecutive calls are ≤ 10 s: the burst shape of one panel opening, each pass paying the full price
// again.
//
// What may be memoised, and what may not. Enumeration MUST stay fresh: an env whose directory was removed
// has to disappear from the list, and that is judged from the directory, not from this memo (the memo is
// only consulted for paths the fresh enumeration just produced). The ANSWER to "which version is this
// binary" cannot change without the binary changing, so it is keyed on the binary's own fingerprint and
// re-stat'ed on every read:
//
//   · a replaced or upgraded interpreter misses at once (fingerprint differs);
//   · a path that cannot be stat'ed is never memoised — there would be nothing to invalidate against;
//   · a NEGATIVE answer is memoised too (a row that says "Needs jsonlite" is just as expensive to
//     re-derive), but only for the same bounded age, and the write paths that install into an env clear
//     the memo outright — see `clearInterpreterProbeCache` and its callers.
//
// In-flight probes are joined rather than repeated: two panel reads that land in the same tick would
// otherwise spawn the same 28 subprocesses twice.

import { statSync } from 'node:fs'

/** What a probe can answer: a version string, a runnability flag, or "it did not run". */
export type InterpreterProbeAnswer = string | boolean | undefined

export type InterpreterProbeMemo = {
  /** Answers from the memo when the binary's fingerprint and age both still allow it. */
  read: <T extends InterpreterProbeAnswer>(
    key: string,
    interpreterPath: string,
    probe: () => Promise<T>
  ) => Promise<T>
  /** Forgets every answer — the env write paths call this after an install/create/import. */
  clear: () => void
  /** Entry count, for tests and for the support bundle's honesty about what it holds. */
  size: () => number
}

const DEFAULT_TTL_MS = 60_000
const DEFAULT_MAX_ENTRIES = 512

/** `mtime:size` of the binary itself (symlinks followed), or `undefined` when it cannot be stat'ed. */
export const fingerprintInterpreterBinary = (interpreterPath: string): string | undefined => {
  try {
    const stat = statSync(interpreterPath)
    return `${stat.mtimeMs}:${stat.size}`
  } catch {
    return undefined
  }
}

type Entry = { at: number; fingerprint: string; result: InterpreterProbeAnswer }
type InFlight = { fingerprint: string; promise: Promise<InterpreterProbeAnswer> }

export const createInterpreterProbeMemo = (
  options: {
    ttlMs?: number
    now?: () => number
    fingerprint?: (interpreterPath: string) => string | undefined
    maxEntries?: number
  } = {}
): InterpreterProbeMemo => {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  const now = options.now ?? Date.now
  const fingerprintOf = options.fingerprint ?? fingerprintInterpreterBinary
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
  const answered = new Map<string, Entry>()
  const running = new Map<string, InFlight>()

  const fresh = (entry: Entry, fingerprint: string): boolean =>
    entry.fingerprint === fingerprint && now() - entry.at < ttlMs

  const store = (key: string, fingerprint: string, result: InterpreterProbeAnswer): void => {
    // A long-lived process walking many envs must not grow this without bound. Clearing is safe — every
    // entry is re-derivable — and it is simpler to reason about than a per-entry eviction order.
    if (answered.size >= maxEntries && !answered.has(key)) answered.clear()
    answered.set(key, { at: now(), fingerprint, result })
  }

  const read = async <T extends InterpreterProbeAnswer>(
    key: string,
    interpreterPath: string,
    probe: () => Promise<T>
  ): Promise<T> => {
    const fingerprint = fingerprintOf(interpreterPath)
    if (fingerprint === undefined) return probe()

    const memoised = answered.get(key)
    if (memoised && fresh(memoised, fingerprint)) return memoised.result as T

    const inFlight = running.get(key)
    if (inFlight && inFlight.fingerprint === fingerprint) return inFlight.promise as Promise<T>

    const promise = probe()
      .then((result) => {
        store(key, fingerprint, result)
        return result
      })
      .finally(() => {
        if (running.get(key)?.promise === promise) running.delete(key)
      })
    running.set(key, { fingerprint, promise })
    return promise as Promise<T>
  }

  return {
    read,
    clear: (): void => {
      answered.clear()
      running.clear()
    },
    size: (): number => answered.size
  }
}
