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
 * The failure text. It names three things a reader previously had to guess at: which launch log is theirs,
 * whether the process died or was alive, and the tail of that launch's own output.
 */
const launchFailureMessage = (input: {
  reason: string
  logPath: string
  exit: AppExit | undefined
  tail: string[]
}): string => {
  const lines = [
    `${LAUNCH_FAILURE_PREFIX}: ${input.reason}`,
    `  process: ${describeAppExit(input.exit)}`,
    `  launch log: ${input.logPath}`
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
 * Resolves with the ready page, or rejects with a message that names the cause. The exit branch matters
 * most: a dead process fails the spec in milliseconds instead of spending the full 30 s timeout, and the
 * reason it died is in the log the message points at.
 */
const openWindowOrNameFailure = async (watch: WindowWatch): Promise<unknown> => {
  const outcome = await raceWindowAgainstExit(watch)
  if (outcome.kind === 'window') return watch.open(outcome.window)

  const tail = await watch.readTail().catch(() => [] as string[])
  if (outcome.kind === 'exited') {
    throw new Error(
      launchFailureMessage({
        reason: 'the process exited before it produced a window',
        logPath: watch.logPath,
        exit: outcome.exit,
        tail
      })
    )
  }

  const reason = outcome.error instanceof Error ? outcome.error.message : String(outcome.error)
  throw new Error(
    launchFailureMessage({
      reason,
      logPath: watch.logPath,
      exit: undefined,
      tail
    }),
    { cause: outcome.error }
  )
}

export {
  APP_PROCESS_LOG_DIRNAME,
  appProcessLogDir,
  appProcessLogPath,
  describeAppExit,
  launchFailureMessage,
  launchHeader,
  launchLogFileName,
  openWindowOrNameFailure,
  readTailLines,
  raceWindowAgainstExit
}
export type { AppExit, LaunchLogIdentity, WindowWatch }
