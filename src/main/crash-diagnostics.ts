import type { Details as ChildProcessGoneDetails, Event as ElectronEvent } from 'electron'

import { diagnosticErrorFields } from './logger'

type LocalCrashReporterStartOptions = {
  productName: string
  companyName: string
  uploadToServer: false
  compress: false
  extra: { appVersion: string }
}

type LocalCrashReportingStatus = { enabled: true; uploadsEnabled: false } | { enabled: false }

type StartLocalCrashReportingOptions = {
  platform: NodeJS.Platform
  productName: string
  companyName: string
  appVersion: string
  start: (options: LocalCrashReporterStartOptions) => void
}

type ChildProcessGoneListener = (event: ElectronEvent, details: ChildProcessGoneDetails) => void

type DiagnosticLogger = {
  error: (message: string, metadata: Record<string, unknown>) => void
}

// Starts local-only Crashpad before a Windows renderer can be created. Other platforms keep their
// existing crash-reporting behavior and never call Electron's crashReporter.start().
const startLocalCrashReporting = ({
  platform,
  productName,
  companyName,
  appVersion,
  start
}: StartLocalCrashReportingOptions): LocalCrashReportingStatus => {
  if (platform !== 'win32') return { enabled: false }

  start({
    productName,
    companyName,
    uploadToServer: false,
    compress: false,
    extra: { appVersion }
  })

  return { enabled: true, uploadsEnabled: false }
}

// Binds app-level GPU/utility diagnostics while deliberately projecting only lifecycle vocabulary
// and numeric exit metadata; command lines, URLs, and filesystem paths never reach main.log.
const installChildProcessGoneLogging = (
  register: (listener: ChildProcessGoneListener) => void,
  log: DiagnosticLogger
): void => {
  register((_event, details) => {
    log.error('child process gone', {
      type: details.type,
      reason: details.reason,
      exitCode: details.exitCode,
      serviceName: details.serviceName,
      name: details.name
    })
  })
}

// ---------------------------------------------------------------------------------------------
// Process failure capture (v2.0.0 P0-2)
//
// Real evidence, 2026-10-01 → 10-10: the packaged app recorded 1,481 `uncaughtException` events
// (1,344 network / 137 system) and every single record carried ONE field — `errorCategory`. No message,
// no stack, no count: 604 of them landed in a single hour on 10-04 and nothing on screen or in the log
// said so. Two separate defects came out of that reading, and this module fixes both:
//
//   1. Undiagnosable records. A category alone cannot distinguish "the provider refused the request"
//      from "DNS died" from "the engine aborted a write". The record now carries a redacted message, the
//      first stack frame, and a stable signature, so repeats are recognisable across runs.
//   2. Unbounded repetition. Nothing folded or throttled the burst, so one flaky minute could push
//      thousands of lines through a rotating 5 MB log and evict the context around it.
//
// The privacy constraint that produced the category-only projection still holds, so the added text is
// redacted before it is kept: URLs, absolute paths, identifiers, e-mail addresses and long opaque tokens
// are replaced, the message is bounded, and the stack frame keeps only a function name plus a file
// BASENAME with line/column — enough to locate the code, never enough to leak the user's filesystem,
// endpoints or prompts.
// ---------------------------------------------------------------------------------------------

export type ProcessFailureSource = 'uncaughtException' | 'unhandledRejection'

export type ProcessFailureRecord = {
  failureSource: ProcessFailureSource
  errorCategory: string
  errorName: string
  /** Redacted, whitespace-collapsed, bounded. */
  message: string
  /** `function (file:line:col)` with a basename-only file, or 'unavailable' when no stack exists. */
  frame: string
  /** 1 for a single event; >1 when repeats inside the window were folded into this record. */
  occurrences: number
  firstAt: string
  lastAt: string
  /** Emission backoff currently applied to this signature, in milliseconds. */
  windowMs: number
}

export type ProcessFailureCaptureOptions = {
  log: DiagnosticLogger
  now?: () => number
  /** Window over which repeats of one signature fold into a single record. */
  windowMs?: number
  /** Each emitted record multiplies its own window by this factor (throttles a sustained burst). */
  backoffFactor?: number
  maxWindowMs?: number
  /** Bound for the redacted message kept in a record. */
  maxMessageChars?: number
}

export type ProcessFailureCapture = {
  (failure: unknown, source: ProcessFailureSource): void
  /** Emits every open window that has unemitted occurrences; returns how many records were written. */
  flush: () => number
  /** Occurrences folded but not yet emitted (diagnostics/tests). */
  pending: () => number
}

const DEFAULT_WINDOW_MS = 60_000
const DEFAULT_BACKOFF_FACTOR = 2
const DEFAULT_MAX_WINDOW_MS = 8 * 60_000
const DEFAULT_MAX_MESSAGE_CHARS = 300

const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi
const EMAIL_PATTERN = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g
// Windows drive paths and POSIX paths with at least one separator (a bare `/tmp` is still a path).
const PATH_PATTERN = /(?:[A-Za-z]:[\\/]|\/)[^\s"'()[\],;:]+(?:[\\/][^\s"'()[\],;:]+)*/g
const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi
const OPAQUE_TOKEN_PATTERN = /\b[A-Za-z0-9+/_=-]{40,}\b/g

/**
 * Redacts a failure's text before it is allowed into the log. Order matters: URLs and e-mails are
 * replaced before the path pattern so a URL's own slashes cannot be re-matched as a filesystem path.
 */
const redactFailureText = (value: string, maxChars: number): string => {
  const redacted = value
    .replace(URL_PATTERN, '<url>')
    .replace(EMAIL_PATTERN, '<email>')
    .replace(PATH_PATTERN, '<path>')
    .replace(UUID_PATTERN, '<id>')
    .replace(OPAQUE_TOKEN_PATTERN, '<token>')
    .replace(/\s+/g, ' ')
    .trim()
  return redacted.length > maxChars ? `${redacted.slice(0, maxChars)}…` : redacted
}

const safeRead = (value: object, key: string): unknown => {
  try {
    return (value as Record<string, unknown>)[key]
  } catch {
    return undefined
  }
}

/** Names the first stack frame as `function (basename:line:col)` — no directories leave the process. */
const firstStackFrame = (stack: unknown): string => {
  if (typeof stack !== 'string') return 'unavailable'
  for (const line of stack.split('\n').slice(1)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('at ')) continue
    const body = trimmed.slice(3)
    const withParens = /^(.+?)\s+\((.+)\)$/.exec(body)
    const location = withParens ? withParens[2] : body
    const caller = withParens ? withParens[1] : ''
    const parts = location.split(/[\\/]/)
    const tail = parts[parts.length - 1] ?? location
    return caller ? `${caller} (${tail})` : tail
  }
  return 'unavailable'
}

const normalizeFailure = (
  failure: unknown,
  source: ProcessFailureSource,
  maxMessageChars: number
): FailureSignatureCore => {
  const fields = diagnosticErrorFields(failure)
  const isObject = typeof failure === 'object' && failure !== null

  const rawMessage = isObject
    ? safeRead(failure, 'message')
    : typeof failure === 'string'
      ? failure
      : undefined
  const message =
    typeof rawMessage === 'string' && rawMessage !== ''
      ? redactFailureText(rawMessage, maxMessageChars)
      : '(no message)'

  const rawName = isObject ? safeRead(failure, 'name') : undefined
  const errorName = typeof rawName === 'string' && rawName !== '' ? rawName : 'Unknown'

  return {
    failureSource: source,
    errorCategory: fields.errorCategory,
    errorName,
    message,
    frame: firstStackFrame(isObject ? safeRead(failure, 'stack') : undefined)
  }
}

// The fields that identify a failure, without the per-window bookkeeping the signature map adds.
type FailureSignatureCore = Omit<
  ProcessFailureRecord,
  'occurrences' | 'firstAt' | 'lastAt' | 'windowMs'
>

type SignatureState = {
  count: number
  firstAtMs: number
  lastAtMs: number
  windowStartMs: number
  windowMs: number
  emitted: number
}

/**
 * Builds the process-level failure recorder. The first event of a signature is written immediately (a
 * single failure must never be invisible); repeats inside the window are only counted, and each closed
 * window writes one record carrying the folded count. The window then doubles per emitted record up to
 * `maxWindowMs`, so a sustained storm converges on a handful of lines instead of thousands.
 */
export const createProcessFailureCapture = (
  options: ProcessFailureCaptureOptions
): ProcessFailureCapture => {
  const now = options.now ?? ((): number => Date.now())
  const baseWindowMs = options.windowMs ?? DEFAULT_WINDOW_MS
  const backoffFactor = options.backoffFactor ?? DEFAULT_BACKOFF_FACTOR
  const maxWindowMs = options.maxWindowMs ?? DEFAULT_MAX_WINDOW_MS
  const maxMessageChars = options.maxMessageChars ?? DEFAULT_MAX_MESSAGE_CHARS

  const states = new Map<string, { record: FailureSignatureCore; state: SignatureState }>()

  const write = (record: FailureSignatureCore, state: SignatureState): void => {
    options.log.error(record.failureSource, {
      errorCategory: record.errorCategory,
      errorName: record.errorName,
      message: record.message,
      frame: record.frame,
      occurrences: state.count,
      firstAt: new Date(state.firstAtMs).toISOString(),
      lastAt: new Date(state.lastAtMs).toISOString(),
      windowMs: state.windowMs
    })
  }

  const flushAll = (): number => {
    let written = 0
    const at = now()
    for (const entry of states.values()) {
      const { record, state } = entry
      if (state.count <= state.emitted) continue
      write(record, state)
      state.emitted = state.count
      // A flushed record still pays the backoff: the next window for this signature is longer.
      state.windowMs = Math.min(maxWindowMs, Math.max(baseWindowMs, state.windowMs * backoffFactor))
      state.windowStartMs = at
      written += 1
    }
    return written
  }

  const capture = (failure: unknown, source: ProcessFailureSource): void => {
    const at = now()
    const normalized = normalizeFailure(failure, source, maxMessageChars)
    const signature = [
      source,
      normalized.errorName,
      normalized.errorCategory,
      normalized.message,
      normalized.frame
    ].join('\u0000')

    const existing = states.get(signature)
    if (!existing) {
      const state: SignatureState = {
        count: 1,
        firstAtMs: at,
        lastAtMs: at,
        windowStartMs: at,
        windowMs: baseWindowMs,
        emitted: 0
      }
      write(normalized, state)
      state.emitted = 1
      states.set(signature, { record: normalized, state })
      return
    }

    // A repeat after the window closed is summarised first (its count must not be lost), and the new
    // window starts at this event.
    if (at - existing.state.windowStartMs >= existing.state.windowMs) {
      write(existing.record, existing.state)
      existing.state.emitted = existing.state.count
      existing.state.windowMs = Math.min(
        maxWindowMs,
        Math.max(baseWindowMs, existing.state.windowMs * backoffFactor)
      )
      existing.state.windowStartMs = at
      existing.record = normalized
    }

    existing.state.count += 1
    existing.state.lastAtMs = at
  }

  const captureWithHelpers = capture as ProcessFailureCapture
  captureWithHelpers.flush = flushAll
  captureWithHelpers.pending = (): number => {
    let pending = 0
    for (const entry of states.values()) {
      pending += Math.max(0, entry.state.count - entry.state.emitted)
    }
    return pending
  }
  return captureWithHelpers
}

export { installChildProcessGoneLogging, startLocalCrashReporting }
