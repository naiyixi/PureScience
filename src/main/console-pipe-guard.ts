// Keeps a closed console reader from becoming an uncaught exception.
//
// Real evidence, packaged 2.26.0, 2026-11-09T16:17:47Z → 16:27:10Z: the log holds 54 `uncaughtException`
// records whose message is exactly `write EPIPE` and whose first frame is
// `afterWriteDispatched (stream_base_commons:159:15)`, all folded out of a single ten-minute window. In
// that same window the log wrote 56 records — i.e. very nearly one EPIPE per mirrored line. Every
// `console.*` call in the main process writes to `process.stdout` or `process.stderr`, and Node leaves
// those two streams with no `error` listener: when the reader goes away (the terminal that launched the
// app exits, a supervisor closes the pipe), the next write raises `EPIPE` on the stream, and an unhandled
// `error` event on a stream is re-raised as a process-level uncaught exception. So the app reported a
// "system failure" once per log line for ten minutes while nothing at all was wrong with it — and each of
// those records is exactly the kind of noise that hides a real one.
//
// The guard is deliberately narrow. It only listens on the two process-level console streams; every other
// `uncaughtException` still reaches `crash-diagnostics` unchanged. It reports once per stream (a burst of
// failed writes is one fact, not N), and it tells the caller BEFORE it logs, so the caller can stop
// mirroring first — a log line about a dead console pipe must not itself be written to that pipe.

export type ConsoleStreamName = 'stdout' | 'stderr'

export type ConsolePipeFailure = {
  stream: ConsoleStreamName
  /** Node's error code when the error carries one (`EPIPE`, `EIO`, …); `unknown` otherwise. */
  code: string
  /** Bounded raw message, for the single record this guard emits. */
  message: string
}

/** The only shape the guard needs from a stream: the ability to listen for `error`. */
export type GuardedConsoleStream = {
  on: (event: 'error', listener: (error: unknown) => void) => unknown
}

export type ConsolePipeGuardOptions = {
  stdout: GuardedConsoleStream
  stderr: GuardedConsoleStream
  /** Called once per stream, the first time that stream raises an error. */
  onPipeClosed: (failure: ConsolePipeFailure) => void
}

export type ConsolePipeGuard = {
  /** Attaches the listeners. Safe to call more than once on the same streams. */
  install: () => void
  /** Whether this stream has already failed (and is therefore no longer worth writing to). */
  isBroken: (stream: ConsoleStreamName) => boolean
}

// A single error message is only ever used in one log record; bounding it keeps a pathological message
// from dominating that line without hiding the code, which is what the record is really about.
const MAX_MESSAGE_CHARS = 120

const readString = (value: unknown, key: string): string | undefined => {
  if (typeof value !== 'object' || value === null) return undefined
  try {
    const field = (value as Record<string, unknown>)[key]
    return typeof field === 'string' && field !== '' ? field : undefined
  } catch {
    return undefined
  }
}

const describe = (stream: ConsoleStreamName, error: unknown): ConsolePipeFailure => {
  const raw = error instanceof Error ? error.message : readString(error, 'message')
  const message = (raw ?? 'no message').replace(/\s+/g, ' ').trim()
  return {
    stream,
    code: readString(error, 'code') ?? 'no-code',
    message:
      message.length > MAX_MESSAGE_CHARS ? `${message.slice(0, MAX_MESSAGE_CHARS)}…` : message
  }
}

export const createConsolePipeGuard = (options: ConsolePipeGuardOptions): ConsolePipeGuard => {
  const broken = new Set<ConsoleStreamName>()
  // Repeated `install()` calls on this guard must not stack listeners (Node warns past ten and the same
  // failure would be reported more than once); a second guard is a separate subscriber and reports on its
  // own, which is why this is per guard rather than per stream object.
  let installed = false

  const listen = (stream: ConsoleStreamName, target: GuardedConsoleStream): void => {
    target.on('error', (error: unknown) => {
      // Report the first failure on this stream only: a destroyed pipe keeps failing on every write, and
      // the interesting fact is "this reader is gone", not how many writes noticed.
      if (broken.has(stream)) return
      broken.add(stream)
      options.onPipeClosed(describe(stream, error))
    })
  }

  return {
    install: (): void => {
      if (installed) return
      installed = true
      listen('stdout', options.stdout)
      listen('stderr', options.stderr)
    },
    isBroken: (stream: ConsoleStreamName): boolean => broken.has(stream)
  }
}
