// Support bundle: everything a maintainer needs to diagnose an installation, assembled locally.
//
// The privacy rule this module exists to enforce: a bundle leaves the device only after the finished archive
// has been read back and checked to contain no home path, no user name, and no secret-shaped value. Logs
// already avoid absolute paths by convention (see the storage log in `ipc.ts`), but third-party stack traces
// do not follow that convention, so every copied file is scrubbed first and the archive itself is re-read
// afterwards. A bundle that fails the check is deleted rather than handed over — failing loudly beats
// shipping a leak, and the check reads what actually ships instead of trusting the scrubbing pass.

import { readdir, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { cpus, release, totalmem, uptime } from 'node:os'
import * as tar from 'tar'

import type { ModelWeightManifestReport } from '../engines/model-weight-manifest-file'
import { buildTrajectoryDocuments, type TrajectoryInput } from '../trajectory/bundle-payload'
import type { HostTimelineSummary } from './host-stall-sampler'
import type { SlowOperationSummary } from './slow-operation-ring'
import type { StallRecordSummary } from './stall-record-ring'
import type { StartupStepsSummary } from './startup-steps-snapshot'

export type SupportBundleVersions = {
  app: string
  electron: string
  chrome: string
  node: string
}

export type SupportBundleInput = {
  /** Directory holding the rotated runtime logs. Copied newest-first up to `maxLogBytes`. */
  logDir: string
  /** Where the finished `.tar.gz` is written. */
  outPath: string
  versions: SupportBundleVersions
  platform: NodeJS.Platform
  arch: string
  locale: string
  timezone: string
  packaged: boolean
  /**
   * Location class only — never the path itself. Absolute paths (including reversible code-point
   * renderings) can expose user and folder names, which is exactly what this bundle must not carry.
   */
  storageLocation: 'default' | 'custom'
  /**
   * The shipped local-parsing-model manifest, as the app's own reader found it. Required, not optional:
   * this is a fact the app always has, and a fact that can be silently omitted is a fact that goes
   * missing exactly when it matters (an `invalid` manifest is why a bundle gets attached).
   *
   * The reading is pathless by construction (`ModelWeightManifestReport`), because a bundle leaves the
   * device — carrying the path would hand over the folder layout this module exists to spare.
   */
  localParsingModels: ModelWeightManifestReport
  /**
   * The stall watchdog's recent records, from its own bounded ring (see `stall-record-ring`). Required, for
   * the same reason as `localParsingModels`: a bundle is normally exported right after something hung, and
   * this is the reading that question needs. The logs carry the whole history under a byte cap; this file is
   * the machine-readable tail plus how many records no longer fit, so "no stalls" and "we stopped keeping
   * them" stay two answers.
   */
  stalls: StallRecordSummary
  /**
   * The host sampler's ring in the minutes before the export (see `host-stall-sampler`). Required for the same
   * reason as `stalls`: the stall records answer "what did the machine look like inside a hang", and every
   * question a bundle is attached for that has *no* stall window — "it was slow for an hour", "it froze when I
   * clicked save" — has no answer at all without this. Its own `status` names the three cases, so a bundle
   * exported before the sampler started says so instead of shipping an empty list that reads like a calm
   * machine.
   */
  hostTimeline: HostTimelineSummary
  /**
   * The startup composition's own breakdown (see `startup-steps-snapshot`). Required for the same reason as
   * `stalls`: a bundle is attached when the app "takes forever to start", and the logs already say how long the
   * window took — what they cannot answer is which step spent it. Its `status` names the absent case, so a
   * bundle exported before composition closed never ships an empty step list that reads like a fast startup.
   */
  startupSteps: StartupStepsSummary
  /**
   * The slow calls this process served, from their bounded ring (see `slow-operation-ring`). Required for the
   * same reason as `stalls`: the lines that explain a slow window are log lines, and the log they land in is
   * large enough that the newest-first byte cap can already have rotated them out by the time a bundle is
   * exported. This is the machine-readable tail, with the same held/own split, plus how many records no
   * longer fit — its `status` names the empty case instead of shipping a list that reads like a fast app.
   */
  slowOperations: SlowOperationSummary
  counts?: { sessions?: number; projects?: number }
  /**
   * Optional trajectory section (v2.19 §2). Written under `trajectory/` through the same scrubber as
   * everything else, and covered by the same read-back check — a bundle that still carried a credential
   * is deleted, not handed over. Absent when the app could not read a session to describe.
   */
  trajectory?: TrajectoryInput
  /** Home directory to scrub from every copied file. Defaults to the environment's home. */
  homeDir?: string
  /** User name to scrub. Defaults to the base name of `homeDir`. */
  userName?: string
  maxLogBytes?: number
  now?: () => Date
  /** Test seam: skip the scrubbing pass. The read-back check still runs, so a leak is still refused. */
  scrub?: boolean
}

export type SupportBundleResult = {
  path: string
  entries: string[]
  bytes: number
  redactions: number
}

export const DEFAULT_MAX_LOG_BYTES = 8 * 1024 * 1024

// Secret-shaped values. Deliberately broad: a false positive costs a support engineer one round trip, a
// false negative ships a credential. Found by this module's own read-back check: `Authorization: Bearer
// ghu_...` used to keep the token, because the value was taken only up to the first space.
const SECRET_PATTERNS: readonly RegExp[] = [
  // Labelled assignments. The value is the whole rest of the line, which is what covers the `Bearer <token>`
  // shape; quoted and unquoted values behave the same way.
  /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|secret|password|passwd|credential|authorization|bearer)["']?\s*[:=]\s*)([^\n]{4,})/gi,
  // Unlabelled token shapes from providers this application talks to, plus cloud and JWT forms.
  /\b(?:sk|ghu|ghp|gho|xoxb|xoxp)-[A-Za-z0-9_-]{12,}\b/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{12,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g
]

const README = `PureScience support bundle
=========================

What is in here
---------------
manifest.json      application, Electron, Chrome and Node versions, plus platform and timezone
environment.json   operating system, CPU model and count, memory, uptime
runtime.json       storage location class (never the path), session and project counts
parsing-models.json  the local-parsing-model manifest this build ships: which copy answered, whether it
                   validated, how many entries it declares (absent when there is no trustworthy count)
diagnostics/event-loop-stalls.json
                   the last event-loop stalls this process saw, as the watchdog recorded them: how long the
                   loop was late, how much CPU that window used, what the machine looked like inside it
                   (free memory, load, paging), the frames V8 sampled, and — when present — the timeline a
                   sampler thread took while the loop was held. Its own counters say how many stalls were
                   observed and how many are no longer kept, so an empty list never reads as "nothing wrong"
diagnostics/host-timeline.json
                   one reading per quarter second from a thread of our own: when each was taken, the CPU it
                   used, free memory, load average and resident size, plus the paging counters while the
                   platform exposes them. The section says how much history it holds and how much it has
                   already discarded, because the machine moments before an export are the question when
                   nothing crossed the stall threshold. Its status names "no samples yet" and "sampler not
                   started" rather than leaving an empty list to be read as a calm machine
diagnostics/startup-steps.json
                   the startup composition step by step: how long each named step took, the CPU it used,
                   whether that time was ours, and any part of it the event loop spent held by other work.
                   totalMs is the window, stepMs is what the named steps cover, gapMs is the rest (time
                   between steps no step can name) — the three always add up. Its status says
                   "not-recorded" when the bundle was exported before composition closed, so an absent
                   breakdown never reads as a fast startup
diagnostics/slow-operations.json
                   the slow calls this process served, newest last: which channel or application command, how
                   long the caller waited, the CPU that window consumed, and the part of it the event loop
                   spent held by other work. Its counters say how many were observed and how many are no
                   longer kept, so a short list never reads as "nothing was slow"
logs/              the most recent runtime logs, scrubbed

Privacy
-------
Nothing in this bundle was transmitted anywhere: it was written to the file you chose, on this device.
After the archive was built it was read back and checked for your home directory, your user name and
secret-shaped values; a bundle that still contained any of them would have been deleted instead of saved.

Sharing
-------
Attach the .tar.gz to your support request. It contains no credentials and no paths from your machine.
`

export const scrubText = (
  text: string,
  needles: readonly string[]
): { text: string; redactions: number } => {
  let redactions = 0
  let next = text
  for (const needle of needles) {
    const parts = next.split(needle)
    if (parts.length > 1) {
      redactions += parts.length - 1
      next = parts.join('<path>')
    }
  }
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0
    next = next.replace(pattern, (_match, prefix: string) => {
      redactions += 1
      return `${prefix}[REDACTED]`
    })
  }
  return { text: next, redactions }
}

export const findLeak = (contents: string, needles: readonly string[]): string | undefined => {
  for (const needle of needles) {
    if (needle && contents.includes(needle)) return `"${needle}"`
  }
  // Ask the scrubber itself, on the text as it stands: if a second pass would still change something, the
  // archive carries a secret. Comparing to the scrubbed form rather than re-testing the patterns keeps the
  // check and the scrubbing from drifting apart — and an already-scrubbed value is a fixed point, so the
  // replacement text cannot be mistaken for the leak.
  if (scrubText(contents, []).text !== contents) return 'a secret-shaped value'
  return undefined
}

const listFilesUnder = async (root: string, prefix = ''): Promise<string[]> => {
  const entries = await readdir(join(root, prefix), { withFileTypes: true }).catch(() => [])
  const files: string[] = []
  for (const entry of entries) {
    const relative = prefix ? join(prefix, entry.name) : entry.name
    if (entry.isDirectory()) files.push(...(await listFilesUnder(root, relative)))
    else if (entry.isFile()) files.push(relative)
  }
  return files
}

const listLogFilesNewestFirst = async (logDir: string): Promise<string[]> => {
  const entries = await readdir(logDir).catch(() => [] as string[])
  const files = await Promise.all(
    entries.map(async (name) => {
      const full = join(logDir, name)
      const info = await stat(full).catch(() => undefined)
      return info?.isFile() ? { full, mtime: info.mtimeMs } : undefined
    })
  )
  return (
    files
      .filter((file): file is { full: string; mtime: number } => !!file)
      // Ties are real, and an arbitrary order there silently decides which logs survive the byte cap: a
      // filesystem with coarse mtime granularity reports the same time for writes that happened milliseconds
      // apart. Name descending is the tie-breaker — the active log (`<name>.log`) sorts after its rotated
      // backups (`<name>.1.log`), so the file a support engineer wants first is the one that wins.
      .sort(
        (left, right) =>
          right.mtime - left.mtime || (right.full > left.full ? 1 : right.full < left.full ? -1 : 0)
      )
      .map((file) => file.full)
  )
}

/** Lists the files inside a written bundle — used by callers and by tests to assert what shipped. */
export const listSupportBundleEntries = async (path: string): Promise<string[]> => {
  const entries: string[] = []
  await tar.list({
    file: path,
    onentry: (entry) => {
      // Files only: the archive also carries a directory entry for the root, which normalises to an empty
      // string and is not something the bundle contains.
      if (entry.type === 'File') entries.push(entry.path.replace(/^\.\//, ''))
    }
  })
  return entries
}

export const createSupportBundle = async (
  input: SupportBundleInput
): Promise<SupportBundleResult> => {
  const now = input.now ?? (() => new Date())
  const homeDir = input.homeDir ?? process.env.HOME ?? ''
  const userName = input.userName ?? (homeDir ? basename(homeDir) : '')
  const maxLogBytes = input.maxLogBytes ?? DEFAULT_MAX_LOG_BYTES
  const scrub = input.scrub ?? true
  const needles = [homeDir, userName].filter((needle) => needle.length > 2)

  const staging = `${input.outPath}.staging`
  const verification = `${input.outPath}.verify`
  await rm(staging, { recursive: true, force: true })
  await rm(verification, { recursive: true, force: true })
  await mkdir(join(staging, 'logs'), { recursive: true })

  let redactions = 0
  const writeStaged = async (relative: string, contents: string): Promise<void> => {
    const result = scrub ? scrubText(contents, needles) : { text: contents, redactions: 0 }
    redactions += result.redactions
    await writeFile(join(staging, relative), result.text, 'utf8')
  }

  await writeStaged(
    'manifest.json',
    `${JSON.stringify(
      {
        generatedAt: now().toISOString(),
        application: input.versions.app,
        electron: input.versions.electron,
        chrome: input.versions.chrome,
        node: input.versions.node,
        platform: input.platform,
        arch: input.arch,
        locale: input.locale,
        timezone: input.timezone,
        packaged: input.packaged
      },
      null,
      2
    )}\n`
  )
  await writeStaged(
    'environment.json',
    `${JSON.stringify(
      {
        osRelease: release(),
        cpuCount: cpus().length,
        cpuModel: cpus()[0]?.model ?? 'unknown',
        totalMemoryBytes: totalmem(),
        uptimeSeconds: Math.round(uptime())
      },
      null,
      2
    )}\n`
  )
  await writeStaged(
    'runtime.json',
    `${JSON.stringify(
      {
        storageLocation: input.storageLocation,
        sessions: input.counts?.sessions ?? null,
        projects: input.counts?.projects ?? null
      },
      null,
      2
    )}\n`
  )
  // The manifest reading goes through the same scrubber as everything else, but it is pathless before it
  // gets here: the scrubber is the backstop, not the reason it is safe to include.
  await writeStaged('parsing-models.json', `${JSON.stringify(input.localParsingModels, null, 2)}\n`)
  // Its own directory, created here: staging only makes `logs/`, and a section that shares a directory with
  // another one fails the day that other one stops being written (this is how `trajectory/` shipped an
  // ENOENT). Scrubbed like everything else even though the records carry no user text — the backstop is
  // cheap and a frame label could still contain a path.
  await mkdir(join(staging, 'diagnostics'), { recursive: true })
  await writeStaged(
    'diagnostics/event-loop-stalls.json',
    `${JSON.stringify(input.stalls, null, 2)}\n`
  )
  // The sampler's own ring, un-windowed: `event-loop-stalls.json` says what the machine looked like *inside*
  // a hang, and a report that never crossed the stall threshold has none of those. Scrubbed like everything
  // else even though it is numbers — the backstop is cheap and this section is the one that grows.
  await writeStaged(
    'diagnostics/host-timeline.json',
    `${JSON.stringify(input.hostTimeline, null, 2)}\n`
  )
  // The startup window, step by step: the logs say how long composition took, this says which step spent it
  // (and how much of the window no step covers). Scrubbed like everything else — the step names are ours, but
  // the backstop costs nothing and this file is the one a slow-start report exists for.
  await writeStaged(
    'diagnostics/startup-steps.json',
    `${JSON.stringify(input.startupSteps, null, 2)}\n`
  )
  // The slow calls themselves, in the fields their log lines carry: which channel/command, how long the caller
  // waited, how much of that the process was running, and the part the loop spent held. Scrubbed like
  // everything else — channel names and surfaces are ours, but the backstop costs nothing.
  await writeStaged(
    'diagnostics/slow-operations.json',
    `${JSON.stringify(input.slowOperations, null, 2)}\n`
  )
  await writeStaged('README.txt', README)
  // Trajectory section: the documents are already redacted value-by-value, and `writeStaged` scrubs again
  // plus the archive is re-read below. Three layers on purpose — this is the one section that carries a
  // conversation.
  if (input.trajectory) {
    // Staging only creates `logs/`; every section owns its own directory or the first write is an ENOENT
    // (this test caught it: `….staging/trajectory/manifest.json` could not be opened).
    await mkdir(join(staging, 'trajectory'), { recursive: true })
    const bundle = await buildTrajectoryDocuments({
      ...input.trajectory,
      needles: [...(input.trajectory.needles ?? []), ...needles]
    })
    if (bundle.leak) {
      await rm(input.outPath, { force: true })
      await rm(staging, { recursive: true, force: true })
      throw new Error(`Support bundle aborted: trajectory/${bundle.leak} still contains a secret.`)
    }
    for (const [relative, contents] of Object.entries(bundle.files)) {
      await writeStaged(join('trajectory', relative), contents)
    }
    redactions += bundle.redactions
  }
  // Newest logs first, stopping at the cap: a bundle too large to attach is as useless as a leaking one.
  let logBytes = 0
  for (const full of await listLogFilesNewestFirst(input.logDir)) {
    const info = await stat(full).catch(() => undefined)
    if (!info?.isFile() || logBytes + info.size > maxLogBytes) continue
    const contents = await readFile(full, 'utf8').catch(() => undefined)
    if (contents === undefined) continue
    await writeStaged(join('logs', basename(full)), contents)
    logBytes += info.size
  }

  await rm(input.outPath, { force: true })
  await tar.create({ gzip: true, file: input.outPath, cwd: staging }, ['.'])

  // Read the archive back and check what actually ships. This is the guarantee, not the scrubbing pass.
  await mkdir(verification, { recursive: true })
  await tar.extract({ file: input.outPath, cwd: verification })
  const shipped = await listFilesUnder(verification)
  for (const relative of shipped) {
    const contents = await readFile(join(verification, relative), 'utf8').catch(() => '')
    const leak = findLeak(contents, needles)
    if (leak) {
      await rm(input.outPath, { force: true })
      await rm(staging, { recursive: true, force: true })
      await rm(verification, { recursive: true, force: true })
      throw new Error(`Support bundle aborted: ${relative} still contains ${leak} after scrubbing.`)
    }
  }
  await rm(staging, { recursive: true, force: true })
  await rm(verification, { recursive: true, force: true })

  const bundle = await stat(input.outPath)
  return {
    path: input.outPath,
    entries: await listSupportBundleEntries(input.outPath),
    bytes: bundle.size,
    redactions
  }
}
