#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */

// Failure digest for one CI run: names the failing step, the failing test files and the root-cause
// lines, and leaves the full logs on disk.
//
// Why this exists (2026-10-28). Triage of a red lane used to start with `gh run view <id> --log-failed`,
// and in this environment that command answers **nothing while claiming success**: measured across two
// runs and three jobs (including a 4-second job and the 12-minute Verify job) it wrote 0 bytes and exited
// 0, and `GH_DEBUG=api` shows it never even requested a logs endpoint. The readable path is
// `gh api repos/<owner>/<repo>/actions/jobs/<job id>/logs`, which returns the whole job log (11.86 MB for
// the red Verify job of `dae37ac3`). So the cost of one red round was: know that, remember the endpoint,
// download 12 MB by hand, then grep it.
//
// Two properties are deliberate, because an instrument that reads nothing must not look like one that
// found nothing:
//   1. every "no answer" is named (`no-failed-jobs`, `logs-unavailable`, `no-failure-markers`) and none of
//      them exits 0;
//   2. the digest quotes the log rather than summarising it, so a reader can check the claim against the
//      file that is still on disk (the path and byte count are printed).
//
//   node scripts/ci-failure-digest.mjs [<run id> | <sha>] [--repo owner/name] [--out dir]
//                                      [--max-files n] [--max-causes n]
//
// Exit codes: 0 digest produced (at least one cause or failing test file found);
//             1 usage or gh failure; 2 no failed job in that run; 3 job logs came back empty;
//             4 logs read fine but carry no failure marker (so nothing here may be read as a pass).

import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Terminal colour codes survive into the API log; they make every pattern below sight-unseen. Built from
 * the code point rather than written as `\u001b` in a literal so the file carries no control character
 * (the `no-control-regex` rule rejects the literal form, and this is the one place it is needed).
 */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, 'g')
/** Actions prefixes each line with an RFC3339 instant and one space. */
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z /gm

export const stripLogNoise = (text) => text.replace(ANSI, '').replace(TIMESTAMP, '')

/** `FAIL   unit  src/a.test.ts [ src/a.test.ts ]` — pool name varies, the path is the second group. */
const FAIL_LINE = /^\s*FAIL\s+(\S+)\s+(\S+)/
const SUMMARY_LINE = /^\s*(Test Files|Tests|Duration)\s+(\S.*)$/
/** `Caused by:` can repeat (the real log carries `Caused by: Caused by: Error: …`); one cause, one entry. */
const CAUSE_LINE = /^\s*(?:Caused by:\s*)*(?:##\[error\])?(?:Error: |error TS\d+)/
const FRAME_LINE = /^\s*❯ /
const ERROR_MARKER = /^##\[error\]/

/** What two lines about the same failure have in common: the failure itself, not the prefix it wore. */
export const causeKey = (text) =>
  text
    .replace(/^(?:Caused by:\s*)+/, '')
    .replace(/^##\[error\]/, '')
    .trim()

/**
 * What one job's log says about the failure, quoted rather than interpreted.
 *
 * Each cause keeps the stack frame printed right after it: `Error: Electron failed to install correctly`
 * alone says nothing about where, while the frame names the file and line. `errorMarkers` keeps every
 * `##[error]` line — a job can print errors from an earlier step that was allowed to fail, and dropping
 * them would hide that the log mentions two different things (the red `dae37ac3` Verify job carries four
 * mac-feed errors from an earlier step beside the two from the failing test step).
 */
export const readJobLog = (log) => {
  const lines = stripLogNoise(log).split('\n')
  const failedFiles = []
  const summaries = {}
  const causes = []
  const seenCauseKeys = new Set()
  const errorMarkers = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const fail = FAIL_LINE.exec(line)
    if (fail) {
      const file = fail[2]
      if (!failedFiles.includes(file)) failedFiles.push(file)
      continue
    }
    const summary = SUMMARY_LINE.exec(line)
    if (summary) {
      summaries[summary[1]] = summary[2].trim()
      continue
    }
    if (ERROR_MARKER.test(line)) errorMarkers.push(line.trim())
    if (CAUSE_LINE.test(line)) {
      const frame = FRAME_LINE.test(lines[index + 1] ?? '')
        ? ` · at ${lines[index + 1].trim().replace(/^❯ /, '')}`
        : ''
      const cause = `${line.trim().replace(/^##\[error\]/, '')}${frame}`
      // Same failure wearing a different prefix (`##[error]` / a `Caused by:` chain) is one cause: a list
      // that repeats it pushes the reader to think three things failed.
      const key = causeKey(line.trim())
      if (!seenCauseKeys.has(key)) {
        seenCauseKeys.add(key)
        causes.push(cause)
      }
    }
  }
  return { lineCount: lines.length, failedFiles, summaries, causes, errorMarkers }
}

const gh = (args) =>
  execFileSync('gh', args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe']
  })

const ghJson = (path) => JSON.parse(gh(['api', path]))

const resolveRepo = () =>
  gh(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']).trim()

/**
 * A ref or a 7–40 char commit becomes the full 40-char SHA the API matches on; anything git cannot resolve
 * throws here rather than being sent as an empty `head_sha`, which the API answers with EVERY recent run
 * (measured: the first version of this file digested five unrelated failures because of exactly that).
 */
export const resolveSha = (target) => {
  const sha = execFileSync('git', ['rev-parse', target], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
  if (!/^[0-9a-f]{40}$/.test(sha))
    throw new Error(`git rev-parse ${target} gave "${sha}", not a 40-char commit`)
  return sha
}

/** A run that failed is the interesting one; when none failed, the run list itself is what a reader wants. */
export const pickRunIds = (runs) => {
  const failed = runs.filter((run) => run.conclusion === 'failure')
  return (failed.length > 0 ? failed : runs).map((run) => String(run.id))
}

export const resolveRunIds = (repo, target, fetchText) => {
  if (/^\d+$/.test(target)) return [target]
  const sha = resolveSha(target)
  const runs = JSON.parse(
    fetchText(`repos/${repo}/actions/runs?head_sha=${sha}&per_page=50`)
  ).workflow_runs
  // An empty list means "no run for this commit yet" — before the index updates it is also transient, so it
  // is named rather than read as a clean history.
  if (runs.length === 0)
    throw new Error(
      `no workflow run found for ${sha} (indexing can lag a fresh push; retry in ~30s)`
    )
  return pickRunIds(runs)
}

/**
 * `readJson`/`readLog` are injectable so the whole digest — including the "empty log" state — is provable
 * offline against fixture logs; the CLI passes the gh-backed pair.
 */
export const digestRun = ({
  repo,
  runId,
  outDir,
  maxFiles = 15,
  maxCauses = 6,
  readJson = ghJson,
  readLog = (jobId) => gh(['api', `repos/${repo}/actions/jobs/${jobId}/logs`])
}) => {
  const run = readJson(`repos/${repo}/actions/runs/${runId}`)
  const jobs = readJson(`repos/${repo}/actions/runs/${runId}/jobs?per_page=100`).jobs
  const failedJobs = jobs.filter((job) => job.conclusion === 'failure')
  const header = [
    `CI failure digest — run ${run.id} (${run.name}, ${run.conclusion ?? run.status}) · head ${String(run.head_sha).slice(0, 8)}`,
    `repo ${repo} · ${run.html_url}`
  ]
  if (failedJobs.length === 0) {
    return {
      code: 2,
      lines: [
        ...header,
        `no-failed-jobs: ${jobs.length} job(s), none failed (${jobs.map((job) => `${job.name}=${job.conclusion}`).join(', ')})`
      ]
    }
  }
  mkdirSync(outDir, { recursive: true })
  const lines = header
  let markers = 0
  let unreadable = 0
  for (const job of failedJobs) {
    const failingSteps = job.steps
      .filter((step) => step.conclusion === 'failure')
      .map((step) => step.name)
    let log = ''
    let readError = ''
    try {
      log = readLog(job.id)
    } catch (error) {
      readError = String(error.stderr ?? error.message)
        .trim()
        .split('\n')
        .slice(0, 2)
        .join(' / ')
    }
    const logPath = join(outDir, `job-${job.id}.log`)
    writeFileSync(logPath, log)
    lines.push(
      '',
      `job ${job.name} · ${job.conclusion} · failing step(s): ${failingSteps.join(', ') || '(none reported)'}`
    )
    lines.push(`  log: ${logPath} (${log.length} bytes)`)
    if (log.trim().length === 0) {
      unreadable += 1
      lines.push(
        `  logs-unavailable: the API returned an empty log${readError ? ` (${readError})` : ''} — nothing below may be read as 'no failure here'`
      )
      continue
    }
    const findings = readJobLog(log)
    if (findings.summaries['Test Files'])
      lines.push(`  vitest: Test Files ${findings.summaries['Test Files']}`)
    if (findings.summaries.Tests) lines.push(`          Tests ${findings.summaries.Tests}`)
    if (findings.summaries.Duration) lines.push(`          Duration ${findings.summaries.Duration}`)
    if (findings.failedFiles.length > 0) {
      const shown = findings.failedFiles.slice(0, maxFiles)
      lines.push(`  failed test files (${findings.failedFiles.length}):`)
      for (const file of shown) lines.push(`    ${file}`)
      if (findings.failedFiles.length > shown.length) {
        lines.push(
          `    … and ${findings.failedFiles.length - shown.length} more (grep ' FAIL ' ${logPath})`
        )
      }
    }
    if (findings.causes.length > 0) {
      lines.push(
        `  root cause candidates (${findings.causes.length} distinct, first ${Math.min(maxCauses, findings.causes.length)}):`
      )
      for (const cause of findings.causes.slice(0, maxCauses)) lines.push(`    ${cause}`)
    }
    const markerSummary = `  ##[error] lines: ${findings.errorMarkers.length}`
    lines.push(
      findings.errorMarkers.length > 0
        ? `${markerSummary} (last: ${findings.errorMarkers[findings.errorMarkers.length - 1].replace(/^##\[error\]/, '')})`
        : `${markerSummary}`
    )
    markers += findings.causes.length + findings.failedFiles.length + findings.errorMarkers.length
  }
  if (markers === 0) {
    // A log that never arrived says nothing about the failure; printing "no failure markers" over it would
    // turn "we could not read it" into "we read it and it was clean" — the exact trade this tool refuses.
    if (unreadable >= failedJobs.length) return { code: 3, lines }
    lines.push(
      '',
      `no-failure-markers: ${failedJobs.length - unreadable} failed job(s) read, no failing test file, cause line or ##[error] found`
    )
    return { code: unreadable > 0 ? 3 : 4, lines }
  }
  lines.push(
    '',
    'next: the quoted lines above are the claim; grep the printed log for the surrounding block.'
  )
  return { code: 0, lines }
}

const USAGE = `usage: node scripts/ci-failure-digest.mjs [<run id> | <sha>] [--repo owner/name] [--out dir] [--max-files n] [--max-causes n]

Reads one CI run's failed job logs (gh api … /actions/jobs/<id>/logs) and prints the failing step,
the failing test files and the root-cause lines. Full logs are kept in --out (default: a temp dir).
Exit codes: 0 digest produced · 1 usage/gh failure · 2 no failed job · 3 logs empty · 4 no failure marker.`

const parseArgs = (argv) => {
  const options = { target: 'HEAD', repo: '', outDir: '', maxFiles: 15, maxCauses: 6, help: false }
  const rest = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--repo') options.repo = argv[(index += 1)]
    else if (arg === '--out') options.outDir = argv[(index += 1)]
    else if (arg === '--max-files') options.maxFiles = Number(argv[(index += 1)])
    else if (arg === '--max-causes') options.maxCauses = Number(argv[(index += 1)])
    else if (arg.startsWith('-')) throw new Error(`unknown option ${arg}`)
    else rest.push(arg)
  }
  if (rest.length > 1) throw new Error(`expected at most one run id or sha, got ${rest.length}`)
  if (rest.length === 1) options.target = rest[0]
  return options
}

const main = () => {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }
  const repo = options.repo || resolveRepo()
  const outDir =
    options.outDir || join(process.env.TMPDIR ?? '/tmp', `ci-failure-digest-${Date.now()}`)
  const runIds = resolveRunIds(repo, options.target, (path) => gh(['api', path]))
  let code = 0
  for (const runId of runIds) {
    const digest = digestRun({
      repo,
      runId,
      outDir,
      maxFiles: options.maxFiles,
      maxCauses: options.maxCauses
    })
    process.stdout.write(`${digest.lines.join('\n')}\n`)
    code = Math.max(code, digest.code)
  }
  return code
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main()
  } catch (error) {
    const detail =
      String(error.stderr ?? '')
        .trim()
        .split('\n')[0] || String(error.message).split('\n')[0]
    process.stderr.write(`ci-failure-digest: ${detail}\n\n${USAGE}\n`)
    process.exitCode = 1
  }
}
