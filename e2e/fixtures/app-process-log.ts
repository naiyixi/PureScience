import { open } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Naming and narration for the Electron launch's own stdout/stderr.
 *
 * Why this exists: a launch that never produces a window used to be indistinguishable from a launch whose
 * process died on the way up. Both surfaced as `firstWindow: Timeout 30000ms exceeded`, the app output went
 * to a single file that the NEXT launch truncated, and a run's artifact therefore held only the last launch's
 * log — the one that worked. When the certification lane went red on three different specs with that same
 * timeout (2026-10-21), the artifact could not say whether the relaunched app had exited or was merely slow.
 *
 * So the two facts are separated here, by name: one log file per launch (never truncated by a later launch),
 * and a failure message that says whether the process is still running or has exited — with its code/signal.
 */

type AppExit = { code: number | null; signal: string | null }

type LaunchLogIdentity = {
  /** 1-based, monotonic for the whole worker process: the nth launch, across restarts and specs. */
  index: number
  /** The spec's own title — enough to tell which test a leftover log belongs to. */
  testTitle: string
  /** Playwright's retry ordinal, so a retried attempt does not look like the first try. */
  retry: number
}

/** Where per-launch logs live, relative to `test-results/`. */
const APP_PROCESS_LOG_DIRNAME = 'app-process'

const slug = (value: string): string => {
  const collapsed = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
  // Cut before trimming the tail so a long title cannot end in a dangling separator.
  return collapsed.slice(0, 60).replace(/-+$/, '')
}

/**
 * A file name that identifies the launch: ordinal, spec, attempt. Deliberately short — the ordinal is what
 * makes the set of files ordered, and the title is what says whose launch it was.
 */
const launchLogFileName = ({ index, testTitle, retry }: LaunchLogIdentity): string => {
  const ordinal = String(index).padStart(3, '0')
  const name = slug(testTitle)
  const attempt = retry > 0 ? `-retry${retry}` : ''
  return `${ordinal}${name ? `-${name}` : ''}${attempt}.log`
}

const appProcessLogDir = (testResultsRoot: string): string =>
  join(testResultsRoot, APP_PROCESS_LOG_DIRNAME)

const appProcessLogPath = (testResultsRoot: string, identity: LaunchLogIdentity): string =>
  join(appProcessLogDir(testResultsRoot), launchLogFileName(identity))

/** The first line of every launch log: which launch this file belongs to, and where it was pointed. */
const launchHeader = (input: {
  identity: LaunchLogIdentity
  pid: number | undefined
  startedAt: Date
  userDataRoot: string
  storageRoot: string
}): string =>
  [
    `[e2e] launch #${input.identity.index} of "${input.identity.testTitle}" (retry ${input.identity.retry})`,
    `[e2e] pid=${input.pid ?? 'unknown'} startedAt=${input.startedAt.toISOString()}`,
    `[e2e] userDataRoot=${input.userDataRoot}`,
    `[e2e] storageRoot=${input.storageRoot}`,
    ''
  ].join('\n')

/** One phrase, used in the failure message: "exited (code=1, signal=null)" vs "is still running". */
const describeAppExit = (exit: AppExit | undefined): string =>
  exit === undefined
    ? 'is still running'
    : `exited (code=${exit.code === null ? 'null' : String(exit.code)}, signal=${exit.signal ?? 'null'})`

const LAUNCH_FAILURE_PREFIX = 'The Electron app never opened a window'

/**
 * The startup steps the app recorded before its window never arrived.
 *
 * `[startup-step] …` lines are written with `writeSync` on descriptor 1 on purpose: a stream write only
 * queues, so a main thread that stops returning in a native call never drains it (`src/main/diagnostics/
 * startup-step.ts`). That makes this line the one reading a wedged launch still leaves behind. Read here as
 * one phrase so the failure sentence names the step instead of leaving the reader to spot it in the tail.
 *
 * A step outside the module's closed vocabulary cannot be written by the app, so anything else that looks
 * like a marker is ignored rather than reported as a step.
 */
const STARTUP_STEP_LINE = /^\[startup-step\] ([a-z-]+) at (.+)$/

const describeStartupSteps = (lines: string[]): string => {
  const steps: { name: string; at: string }[] = []
  for (const line of lines) {
    const match = STARTUP_STEP_LINE.exec(line.trim())
    if (match !== null) steps.push({ name: match[1], at: match[2] })
  }
  // The tail is bounded, so "none here" is not "none written" — say which of the two this is.
  if (steps.length === 0) {
    return `none among the last ${String(lines.length)} line(s) read — that is not a claim that no step was written`
  }
  const last = steps[steps.length - 1]
  return `last '${last.name}' at ${last.at} ⇒ ${steps.map((step) => step.name).join(' → ')}`
}

/**
 * What Playwright's own connection knows about, read at the moment the wait expired.
 *
 * This is the reading that separates the two shapes the timeout used to leave identical: a window the app
 * really did open (so only the event was missed) and no window at all. `firstWindow()` consults `windows()`
 * before it starts waiting, so a set that was empty then and is non-empty now is a missed event rather than
 * a product failure — `openWindowOrNameFailure` adopts that window instead of failing the spec.
 */
const describeKnownWindows = (known: unknown[] | undefined): string => {
  if (known === undefined) return 'not reported by this caller'
  if (known.length === 0) return 'none — no window was ever published to the connection'
  return `${String(known.length)} (the wait expired with a window already there)`
}

/**
 * The failure text. It names four things a reader previously had to guess at: which launch log is theirs,
 * whether the process died or was alive, how far the app said it got, and the tail of its own output.
 * The fifth — how many windows the connection knew about — is what says whether the app was silent or
 * whether the app opened a window that the connection never learned of.
 */
const launchFailureMessage = (input: {
  reason: string
  logPath: string
  exit: AppExit | undefined
  tail: string[]
  knownWindows?: unknown[]
}): string => {
  const lines = [
    `${LAUNCH_FAILURE_PREFIX}: ${input.reason}`,
    `  process: ${describeAppExit(input.exit)}`,
    `  windows the connection knows about: ${describeKnownWindows(input.knownWindows)}`,
    `  launch log: ${input.logPath}`,
    `  startup steps: ${describeStartupSteps(input.tail)}`
  ]
  if (input.tail.length === 0) {
    lines.push('  (that launch wrote nothing before it was lost — the log file is absent or empty)')
  } else {
    lines.push(`  --- last ${String(input.tail.length)} lines of that launch ---`)
    for (const line of input.tail) lines.push(`  ${line}`)
  }
  return lines.join('\n')
}

const TAIL_BYTE_LIMIT = 64 * 1024

/**
 * The last `maxLines` lines of a log, bounded by bytes so a chatty launch cannot blow up the report.
 * A missing file is reported as text rather than swallowed: "no log" is a fact about the launch.
 */
const readTailLines = async (path: string, maxLines = 20): Promise<string[]> => {
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(path, 'r')
  } catch {
    return []
  }
  try {
    const { size } = await handle.stat()
    const length = Math.min(size, TAIL_BYTE_LIMIT)
    const start = Math.max(0, size - length)
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, start)
    const lines = buffer
      .toString('utf8')
      .split('\n')
      .map((line) => line.replace(/\r$/, ''))
      .filter((line) => line.length > 0)
    return lines.slice(-maxLines)
  } finally {
    await handle.close()
  }
}

type WindowWatch = {
  /** Playwright's own `firstWindow()` (it carries the 30 s ceiling; nothing here changes it). */
  firstWindow: () => Promise<unknown>
  /** Resolves once the app process exits. Must never reject. */
  exited: Promise<AppExit>
  logPath: string
  readTail: () => Promise<string[]>
  /**
   * `application.windows()` — what the connection knows about right now. Optional so a caller without one
   * still works; when present it answers the question the timeout used to leave open (see
   * `describeKnownWindows`). Read only after the wait expired, so the passing path is unchanged.
   */
  windows?: () => unknown[]
  /** Renders the resolved window into the page the specs use. */
  open: (window: unknown) => Promise<unknown>
}

type RaceOutcome =
  | { kind: 'window'; window: unknown }
  | { kind: 'rejected'; error: unknown }
  | { kind: 'exited'; exit: AppExit }

const raceWindowAgainstExit = async (watch: WindowWatch): Promise<RaceOutcome> => {
  const windowOutcome = watch.firstWindow().then(
    (window): RaceOutcome => ({ kind: 'window', window }),
    (error: unknown): RaceOutcome => ({ kind: 'rejected', error })
  )
  const exitOutcome = watch.exited.then((exit): RaceOutcome => ({ kind: 'exited', exit }))
  return Promise.race([windowOutcome, exitOutcome])
}

/**
 * Reads the connection's window set, treating a closed target as "not reported" — a `windows()` that throws
 * says nothing about how many windows existed, and guessing zero would be the very conflation this exists
 * to remove.
 */
const readKnownWindows = (watch: WindowWatch): unknown[] | undefined => {
  if (!watch.windows) return undefined
  try {
    return watch.windows()
  } catch {
    return undefined
  }
}

/**
 * Resolves with the ready page, or rejects with a message that names the cause. The exit branch matters
 * most: a dead process fails the spec in milliseconds instead of spending the full 30 s timeout, and the
 * reason it died is in the log the message points at.
 *
 * The timeout branch has two shapes and now tells them apart: a window the connection knows about (the
 * event was missed — the window is adopted) and no window at all (the app never published one — the failure
 * says so by name). Neither branch waits longer than the budget it was given.
 */
const openWindowOrNameFailure = async (watch: WindowWatch): Promise<unknown> => {
  const outcome = await raceWindowAgainstExit(watch)
  if (outcome.kind === 'window') return watch.open(outcome.window)

  const tail = await watch.readTail().catch(() => [] as string[])
  const known = readKnownWindows(watch)
  if (outcome.kind === 'exited') {
    throw new Error(
      launchFailureMessage({
        reason: 'the process exited before it produced a window',
        logPath: watch.logPath,
        exit: outcome.exit,
        tail,
        knownWindows: known
      })
    )
  }

  if (known !== undefined && known.length > 0) {
    // A window was open when the wait expired, so only the event was missed: `firstWindow()` consults
    // `windows()` before waiting, so this set was empty when the wait began. Adopting it is recovery from a
    // missed event, not a weakened assertion — a window that cannot actually render still fails in `open`.
    console.log(
      `[e2e] window event missed: ${String(known.length)} window(s) were already open when the wait ` +
        'expired — adopting the first instead of failing the spec'
    )
    return watch.open(known[0])
  }

  const reason = outcome.error instanceof Error ? outcome.error.message : String(outcome.error)
  throw new Error(
    launchFailureMessage({
      reason,
      logPath: watch.logPath,
      exit: undefined,
      tail,
      knownWindows: known
    }),
    { cause: outcome.error }
  )
}

export {
  APP_PROCESS_LOG_DIRNAME,
  appProcessLogDir,
  appProcessLogPath,
  describeAppExit,
  describeStartupSteps,
  launchFailureMessage,
  launchHeader,
  launchLogFileName,
  openWindowOrNameFailure,
  readTailLines,
  raceWindowAgainstExit
}
export type { AppExit, LaunchLogIdentity, WindowWatch }
