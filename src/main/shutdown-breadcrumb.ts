// Durable breadcrumb of the application quit sequence.
//
// Why this file exists (real evidence, 2026-10-10): a packaged 1.97.0 run aborted (EXC_CRASH / SIGABRT,
// "Abort trap: 6") roughly five seconds AFTER every shutdown phase had already reported `completed`. The
// crash report's faulting stack is `abort()` inside the Prisma query engine
// (`libquery_engine-darwin-arm64.dylib.node`) reached from `uv_run` →
// `node::Environment::CleanupHandles()` → `node::Environment::RunCleanup()` → `node::FreeEnvironment()`,
// i.e. the process died in native teardown with a live database engine, while our own shutdown journal
// had just written a success line. Two consequences follow, and both are diagnosability defects rather
// than cosmetics:
//
//   * main.log is an async, buffered, rotating sink — after an abort its tail is not evidence of where the
//     process was, and there is no record that the previous exit never finished.
//   * "completed" and "never recorded completion" are different facts, and only an atomic, fsync'd record
//     can tell them apart on the next launch. Guessing between them is exactly the silent-failure shape
//     this project refuses: a phase that was never reached must not read as a phase that passed.
//
// So every phase is written synchronously (tmp file → fsync → rename → directory fsync). Four short writes
// per quit, in exchange for a post-mortem that can always name the last phase the process reached.

import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'

export const SHUTDOWN_BREADCRUMB_FILE = 'shutdown-breadcrumb.json'

export type ShutdownBreadcrumb = {
  schemaVersion: 1
  /** Identifies one process run, so a stale file from an earlier run is never read as this one's. */
  runId: string
  /** How the quit was classified ('quit', 'titlebar-close', 'update-install', ...). */
  trigger: string
  /** ISO timestamp of the first phase write for this quit. */
  startedAt: string
  /** Last phase the process actually recorded. */
  phase: string
  /** ISO timestamp of that phase write. */
  phaseAt: string
  /** Present only when the process recorded the terminal phase. */
  completedAt?: string
  /** Present only when the terminal record knows whether a step failed/time-out. */
  degraded?: boolean
}

export type PreviousShutdown =
  | { kind: 'absent' }
  | { kind: 'unreadable'; reason: 'malformed' | 'wrong-schema' | 'io-error' }
  | { kind: 'completed'; completedAt: string; phase: string; trigger: string; degraded?: boolean }
  | { kind: 'incomplete'; phase: string; phaseAt: string; startedAt: string; trigger: string }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const parseBreadcrumb = (raw: string): ShutdownBreadcrumb | undefined => {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!isRecord(parsed)) return undefined
  if (parsed.schemaVersion !== 1) return undefined
  const strings = ['runId', 'trigger', 'startedAt', 'phase', 'phaseAt'] as const
  if (strings.some((key) => typeof parsed[key] !== 'string' || parsed[key] === '')) return undefined
  if (parsed.completedAt !== undefined && typeof parsed.completedAt !== 'string') return undefined
  if (parsed.degraded !== undefined && typeof parsed.degraded !== 'boolean') return undefined
  return parsed as ShutdownBreadcrumb
}

/**
 * Writes the breadcrumb durably. Synchronous on purpose: it must survive a process that never gets to run
 * another event-loop turn. Never throws — a breadcrumb that cannot be written must not be able to break a
 * quit (the shutdown sequence is authoritative; diagnostics are best-effort).
 */
export const writeShutdownBreadcrumbSync = (
  logDir: string,
  record: ShutdownBreadcrumb
): { written: true } | { written: false; reason: string } => {
  try {
    mkdirSync(logDir, { recursive: true })
    const target = join(logDir, SHUTDOWN_BREADCRUMB_FILE)
    const temporary = `${target}.tmp`
    const bytes = `${JSON.stringify(record)}\n`
    writeFileSync(temporary, bytes)
    // fsync the file first, then the directory, so a rename-then-power-loss ordering cannot leave a
    // directory entry pointing at unwritten bytes.
    const fileHandle = openSync(temporary, 'r')
    try {
      fsyncSync(fileHandle)
    } finally {
      closeSync(fileHandle)
    }
    renameSync(temporary, target)
    // Directory fsync is POSIX-only: Windows cannot open a directory for this. It is a durability
    // nicety (ordering the directory entry), not a correctness requirement — the file's own bytes are
    // already fsync'd above and the rename is atomic — so it is best-effort and must never turn a
    // successful write into a reported failure. Observed on the Windows lane: `openSync(dir, 'r')`
    // threw, the outer catch reported `written: false`, and the record was silently considered absent.
    let dirHandle: number | undefined
    try {
      dirHandle = openSync(logDir, 'r')
      fsyncSync(dirHandle)
    } catch {
      // Platform without directory fsync (Windows), or a filesystem that refuses it.
    } finally {
      if (dirHandle !== undefined) closeSync(dirHandle)
    }
    return { written: true }
  } catch (error) {
    return { written: false, reason: error instanceof Error ? error.name : 'unknown' }
  }
}

/** Reads the breadcrumb, keeping "missing", "unreadable" and "present" as separate facts. */
export const readShutdownBreadcrumb = (logDir: string): ShutdownBreadcrumb | undefined => {
  try {
    return parseBreadcrumb(readFileSync(join(logDir, SHUTDOWN_BREADCRUMB_FILE), 'utf8'))
  } catch {
    return undefined
  }
}

export type ShutdownBreadcrumbWriter = {
  /** Call for every phase the shutdown sequence reaches; `unknown` trigger must be passed explicitly. */
  (phase: string, fields?: Record<string, unknown>): void
  /** The record as last written (tests/diagnostics). */
  last: () => ShutdownBreadcrumb | undefined
  /** Set once the terminal phase has been recorded. */
  isComplete: () => boolean
}

/**
 * Builds the phase writer for one process run. The first call fixes `startedAt`; the `completed` phase
 * writes the terminal record. Failures to write are recorded on `last()` as absent rather than thrown:
 * the quit sequence is authoritative and diagnostics are best-effort.
 */
export const createShutdownBreadcrumbWriter = (options: {
  logDir: string
  runId: string
  now?: () => string
}): ShutdownBreadcrumbWriter => {
  const now = options.now ?? ((): string => new Date().toISOString())
  let startedAt: string | undefined
  let record: ShutdownBreadcrumb | undefined
  let complete = false

  const writer = ((phase: string, fields?: Record<string, unknown>): void => {
    const at = now()
    startedAt ??= at
    const trigger =
      typeof fields?.trigger === 'string' && fields.trigger !== ''
        ? fields.trigger
        : record?.trigger
    const next: ShutdownBreadcrumb = {
      schemaVersion: 1,
      runId: options.runId,
      trigger: trigger ?? 'unknown',
      startedAt,
      phase,
      phaseAt: at,
      ...(typeof fields?.degraded === 'boolean' ? { degraded: fields.degraded } : {})
    }
    // The terminal phase stamps the completion time; a phase recorded after it (there is none today, but
    // the writer must not silently drop the fact if one is added) keeps the original completion stamp.
    if (phase === 'completed') {
      complete = true
      next.completedAt = at
    } else if (complete && record?.completedAt) {
      next.completedAt = record.completedAt
    }
    const result = writeShutdownBreadcrumbSync(options.logDir, next)
    if (result.written) record = next
  }) as ShutdownBreadcrumbWriter

  writer.last = (): ShutdownBreadcrumb | undefined => record
  writer.isComplete = (): boolean => complete
  return writer
}

/**
 * Classifies the previous run's breadcrumb for a fresh process. `incomplete` means the file exists and
 * records phases but no terminal record: the previous process ended without finishing the sequence
 * (abort, kill, power loss). It deliberately does NOT claim "crash" — a force-quit is indistinguishable
 * here, and the caller reports the phase, not a verdict it cannot support.
 */
export const classifyPreviousShutdown = (logDir: string): PreviousShutdown => {
  let raw: string
  try {
    raw = readFileSync(join(logDir, SHUTDOWN_BREADCRUMB_FILE), 'utf8')
  } catch (error) {
    const code = (error as { code?: string } | undefined)?.code
    if (code === 'ENOENT') return { kind: 'absent' }
    return { kind: 'unreadable', reason: 'io-error' }
  }

  const record = parseBreadcrumb(raw)
  if (!record) return { kind: 'unreadable', reason: 'malformed' }

  if (record.completedAt) {
    return {
      kind: 'completed',
      completedAt: record.completedAt,
      phase: record.phase,
      trigger: record.trigger,
      ...(record.degraded === undefined ? {} : { degraded: record.degraded })
    }
  }

  return {
    kind: 'incomplete',
    phase: record.phase,
    phaseAt: record.phaseAt,
    startedAt: record.startedAt,
    trigger: record.trigger
  }
}
