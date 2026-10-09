#!/usr/bin/env node
// Certification-lane reading harvester.
/* eslint-disable @typescript-eslint/explicit-function-return-type */
//
// Why this exists: several units were recorded as "real-machine reading not taken" while the reading
// was already sitting in the macOS certification job's log — the job runs the whole P0 Electron suite
// and every spec prints its own `[tag] ...` lines. Harvesting those by hand costs a round each time,
// so this prints them in one command.
//
// Usage:
//   node scripts/ci/harvest-certification-readings.mjs                     # newest run for origin/main's tip
//   node scripts/ci/harvest-certification-readings.mjs --sha <40 hex>      # newest run for one commit
//   node scripts/ci/harvest-certification-readings.mjs --run <run id>      # a specific run
//   node scripts/ci/harvest-certification-readings.mjs --job <job id>      # a specific job
//   options: --lane <job name substring> (default macos-arm64) --tag <name> --spec <substring>
//            --repo <owner/name> --no-truncate
//
// Discipline baked in: `head_sha` only ever matches a full 40-hex commit id. An 8-character short id
// returns an empty run list, which reads exactly like "nothing was triggered" — so a short id is
// refused by name here instead of being passed through.
//
// Exit codes: 0 ok, 1 fetch failure, 2 usage error.
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

const DEFAULT_REPO = 'naiyixi/PureScience'
const LINE_WIDTH = 220

const parseArgs = (argv) => {
  const out = { lane: 'macos-arm64', repo: DEFAULT_REPO, truncate: true }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const value = () => {
      const next = argv[i + 1]
      if (next === undefined) {
        console.error(`error: ${arg} needs a value`)
        process.exit(2)
      }
      i += 1
      return next
    }
    if (arg === '--sha') out.sha = value()
    else if (arg === '--run') out.run = value()
    else if (arg === '--job') out.job = value()
    else if (arg === '--lane') out.lane = value()
    else if (arg === '--tag') out.tag = value()
    else if (arg === '--spec') out.spec = value()
    else if (arg === '--repo') out.repo = value()
    else if (arg === '--no-truncate') out.truncate = false
    else {
      console.error(`error: unknown option ${arg} (see the header of this file)`)
      process.exit(2)
    }
  }
  return out
}

const ghJson = (path) => JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8' }))

const git = (args) => execFileSync('git', args, { encoding: 'utf8' }).trim()

const pickRun = (runs) => {
  if (runs.length === 0) return undefined
  const nightly = runs.filter((run) => /nightly/i.test(run.name))
  return nightly[0] ?? runs[0]
}

const main = () => {
  const args = parseArgs(process.argv.slice(2))
  const repo = args.repo

  let run
  let job

  if (args.job) {
    job = ghJson(`repos/${repo}/actions/jobs/${args.job}`)
    run = { id: job.run_id, head_sha: job.head_sha, name: `(job of run ${job.run_id})` }
  } else {
    if (args.run) {
      run = ghJson(`repos/${repo}/actions/runs/${args.run}`)
    } else {
      let sha = args.sha
      if (sha && !/^[0-9a-f]{40}$/.test(sha)) {
        console.error(
          `error: --sha must be the full 40-hex commit id (got ${sha.length} chars).\n` +
            '       A short id never matches head_sha and reads like "nothing was triggered".'
        )
        process.exit(2)
      }
      if (!sha) {
        sha = git(['rev-parse', 'origin/main'])
        console.log(`# no --sha/--run/--job given; using origin/main tip ${sha}`)
      }
      const runs = ghJson(`repos/${repo}/actions/runs?head_sha=${sha}&per_page=50`).workflow_runs
      run = pickRun(runs)
      if (!run) {
        console.error(
          `no workflow run found for ${sha}.\n` +
            'That is either an index delay (retry in ~30 s) or a commit whose paths are filtered\n' +
            'out of both lanes (a pure docs commit triggers nothing by design).'
        )
        process.exit(1)
      }
    }
    const jobs = ghJson(`repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`).jobs
    job = jobs.filter((entry) => entry.name.includes(args.lane))[0]
    if (!job) {
      console.error(
        `run ${run.id} has no job matching "${args.lane}". Jobs in it:\n` +
          jobs.map((entry) => `  - ${entry.name} (${entry.conclusion})`).join('\n')
      )
      process.exit(1)
    }
  }

  const logPath = resolve(tmpdir(), `ps-cert-log-${job.id}.txt`)
  const log = execFileSync('gh', ['api', `repos/${repo}/actions/jobs/${job.id}/logs`], {
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024
  })
  writeFileSync(logPath, log, 'utf8')

  // GitHub prefixes every log line with an ISO timestamp; drop it once so the parsers below work on
  // the line as the tool that printed it wrote it.
  const lines = log.split('\n').map((line) => line.replace(/^\d{4}-\d{2}-\d{2}T\S+Z /, ''))
  const clip = (text) =>
    args.truncate && text.length > LINE_WIDTH ? `${text.slice(0, LINE_WIDTH)}…` : text

  console.log(`\n## certification job\n`)
  console.log(`repo    ${repo}`)
  console.log(`run     ${run.name} ${run.id} (${run.head_sha})`)
  console.log(`job     ${job.name} ${job.id} = ${job.conclusion}`)
  console.log(`log     ${logPath} (${log.length} bytes)`)

  const verdict = lines.filter((line) =>
    /electron_p0=|visual_regression=|package_smoke=|failed=\s*-?[0-9]|^- result:|macSignature:/.test(
      line
    )
  )
  console.log(`\n## platform verdict lines (${verdict.length})\n`)
  verdict.forEach((line) => console.log(clip(line)))

  const specs = lines
    .map((line) => /\[\d+\/\d+\]\s+(\S+\.(?:spec|test)\.ts(?::\d+:\d+)?)/.exec(line))
    .filter(Boolean)
    .map((match) => match[1])
  const uniqueSpecs = [...new Set(specs)]
  const filtered = args.spec ? uniqueSpecs.filter((spec) => spec.includes(args.spec)) : uniqueSpecs
  console.log(`\n## specs executed: ${uniqueSpecs.length} (showing ${filtered.length})\n`)
  filtered.forEach((spec) => console.log(`  ${spec}`))

  const summary = lines.filter((line) => /^\s+\d+ (passed|skipped|failed|flaky)\b/.test(line))
  console.log(`\n## run summary\n`)
  summary.forEach((line) => console.log(clip(line.trim())))

  // `[group]` / `[command]` / `[error]` are GitHub's own log markers, not readings the suite printed.
  const LOG_MARKERS = new Set([
    'group',
    'endgroup',
    'command',
    'debug',
    'warning',
    'error',
    'section'
  ])
  const readings = lines
    .map((line) => /\[([a-z0-9][a-z0-9-]{1,24})\]\s(.*)$/.exec(line))
    .filter(Boolean)
    .filter((match) => !LOG_MARKERS.has(match[1]))
    .map((match) => ({ tag: match[1], text: match[2] }))
  const tags = [...new Set(readings.map((entry) => entry.tag))].sort()
  const shown = args.tag ? readings.filter((entry) => entry.tag === args.tag) : readings

  console.log(`\n## readings by tag (${readings.length} lines, ${tags.length} tags)\n`)
  console.log(`tags: ${tags.join(' ') || '(none)'}`)
  for (const tag of [...new Set(shown.map((entry) => entry.tag))].sort()) {
    const group = shown.filter((entry) => entry.tag === tag)
    console.log(`\n--- [${tag}] (${group.length}) ---`)
    group.forEach((entry) => console.log(clip(`  ${entry.text}`)))
  }
  if (shown.length === 0) {
    console.log(
      args.tag
        ? `\n(no reading line carries the tag "${args.tag}" in this log)`
        : '\n(no tagged reading lines in this log — the suite may be a lane that does not run them)'
    )
  }

  console.log(
    `\nHARVESTED specs=${uniqueSpecs.length} readings=${readings.length} tags=${tags.length} ` +
      `job=${job.id} sha=${run.head_sha}`
  )
}

main()
