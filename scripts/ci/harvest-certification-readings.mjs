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
//   node scripts/ci/harvest-certification-readings.mjs --in-repo [tag]     # the OTHER half: what the repo
//                                                                          # itself already records
//   options: --lane <job name substring> (default macos-arm64) --tag <name> --spec <substring>
//            --repo <owner/name> --no-truncate
//
// Discipline baked in: `head_sha` only ever matches a full 40-hex commit id. An 8-character short id
// returns an empty run list, which reads exactly like "nothing was triggered" — so a short id is
// refused by name here instead of being passed through.
//
// The second discipline is why `--in-repo` exists. A lane log with zero `[tag]` lines has TWO causes that
// look identical: nobody took the reading, or the spec that prints it did not run on that machine. Every
// certification spec that needs a machine-local prerequisite guards itself with `test.skip(...)` — the
// curated runtime pack, the scanned-PDF fixture, a user-mode sshd — and a skipped test prints nothing.
// (Measured 2026-10-10: the lane reported exactly 12 skipped, and the tree held exactly 12 such guards.)
// So `--in-repo` scans the repository for the tag and prints the guard inventory next to it: a tag that
// IS recorded in `docs/evidence/` but absent from the lane log is a reading taken on a prepared machine,
// not a missing one. Check both halves before recording anything as "not taken".
//
// Exit codes: 0 ok, 1 fetch failure, 2 usage error.
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

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
    else if (arg === '--in-repo') {
      out.inRepo = true
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        out.inRepoTag = next
        i += 1
      }
    } else {
      console.error(`error: unknown option ${arg} (see the header of this file)`)
      process.exit(2)
    }
  }
  return out
}

const ghJson = (path) => JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8' }))

const git = (args) => execFileSync('git', args, { encoding: 'utf8' }).trim()

// Directories that never carry a recorded reading; skipping them keeps the walk instant and quiet.
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'out',
  'dist',
  'web-dist',
  'test-results',
  'coverage',
  'release'
])

const walk = (dir, out = []) => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(entry)) walk(full, out)
    } else {
      out.push(full)
    }
  }
  return out
}

const TAG_IN_TEXT = /\[([a-z0-9][a-z0-9-]{1,24})\]/g

// The other half of the question: what does the REPOSITORY already record? A lane that prints nothing
// under a tag is not the same as a reading nobody took — the specs that need a machine-local
// prerequisite skip themselves, and a skipped test prints nothing at all.
const repoSearch = (args) => {
  const root = process.cwd()
  const files = [
    ...walk(join(root, 'docs')),
    ...walk(join(root, 'e2e')),
    ...['CHANGELOG.md', 'README.md', 'README.en.md']
      .map((name) => join(root, name))
      .filter((path) => {
        try {
          return statSync(path).isFile()
        } catch {
          return false
        }
      })
  ]

  const byTag = new Map()
  const push = (tag, file, line, text) => {
    const list = byTag.get(tag) ?? []
    list.push({ file: file.slice(root.length + 1), line, text: text.trim() })
    byTag.set(tag, list)
  }

  for (const file of files) {
    let content
    try {
      content = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    if (!content.includes('[')) continue
    content.split('\n').forEach((text, index) => {
      TAG_IN_TEXT.lastIndex = 0
      const local = new Set()
      let match = TAG_IN_TEXT.exec(text)
      while (match) {
        local.add(match[1])
        match = TAG_IN_TEXT.exec(text)
      }
      for (const tag of local) push(tag, file, index + 1, text)
    })
  }

  const wanted = args.inRepoTag
  // In the listing mode, only tags the SUITE itself prints are interesting — Markdown links and regex
  // fragments in prose also match the bracket shape and would bury the real ones.
  const printedBySuite = new Set(
    [...byTag.entries()]
      .filter(([, hits]) =>
        hits.some((hit) => hit.file.startsWith('e2e/') && hit.text.includes('console.log'))
      )
      .map(([tag]) => tag)
  )
  const tags = (wanted ? [...byTag.keys()] : [...printedBySuite]).sort()

  if (!wanted) {
    console.log(`\n## tags the suite prints and the repo records (${tags.length})\n`)
    for (const tag of tags) console.log(`  [${tag}]  ${byTag.get(tag).length} hit(s)`)
    console.log(
      '\nRun again with `--in-repo <tag>` to see where a tag is recorded, and read it next to the lane\n' +
        'harvest: a tag recorded in docs/evidence/ but absent from the lane log is a reading taken on a\n' +
        'prepared machine, NOT a missing one.'
    )
  } else {
    const hits = byTag.get(wanted) ?? []
    console.log(`\n## repo-side record for tag "${wanted}" (${hits.length} hit(s))\n`)
    for (const hit of hits) {
      const text =
        args.truncate && hit.text.length > LINE_WIDTH
          ? `${hit.text.slice(0, LINE_WIDTH)}…`
          : hit.text
      console.log(`  ${hit.file}:${hit.line}  ${text}`)
    }
    const filesWithHits = new Set(hits.map((hit) => hit.file))
    const docsHits = hits.filter((hit) => hit.file.startsWith('docs/')).length
    const e2eHits = hits.filter((hit) => hit.file.startsWith('e2e/')).length
    console.log(
      hits.length === 0
        ? `\nIN-REPO tag=${wanted} hits=0 — nothing in this repository records a reading under that tag.` +
            '\n(That, plus zero lane lines, is what "not taken" actually looks like.)'
        : `\nIN-REPO tag=${wanted} hits=${hits.length} files=${filesWithHits.size} ` +
            `docs=${docsHits} e2e=${e2eHits}`
    )
  }

  // The guard inventory: this is the reason a lane can be silent about a taken reading.
  const certDir = join(root, 'e2e/certification')
  let guards = []
  try {
    for (const name of readdirSync(certDir)
      .filter((entry) => entry.endsWith('.spec.ts'))
      .sort()) {
      readFileSync(join(certDir, name), 'utf8')
        .split('\n')
        .forEach((text, index) => {
          if (text.includes('test.skip(')) {
            guards.push({ file: `e2e/certification/${name}`, line: index + 1, text: text.trim() })
          }
        })
    }
  } catch {
    guards = []
  }
  const guardFiles = new Set(guards.map((guard) => guard.file))
  console.log(
    `\n## lane guards in e2e/certification — a guarded spec prints NOTHING on a lane that lacks its prerequisite` +
      ` (${guards.length} guard(s) across ${guardFiles.size} file(s))\n`
  )
  for (const guard of guards) console.log(`  ${guard.file}:${guard.line}  ${guard.text}`)
  console.log(
    '\nPair this with the lane harvest before calling a reading untaken. Conversely, a lane line that says a' +
      '\nspec ran proves nothing about a reading the spec never printed.'
  )
}

const pickRun = (runs) => {
  if (runs.length === 0) return undefined
  const nightly = runs.filter((run) => /nightly/i.test(run.name))
  return nightly[0] ?? runs[0]
}

const main = () => {
  const args = parseArgs(process.argv.slice(2))
  const repo = args.repo

  if (args.inRepo) {
    repoSearch(args)
    return
  }

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
