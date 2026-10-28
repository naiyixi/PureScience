#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */

// One digest line for the commit a release is about to ship.
//
// Why this exists (2026-10-28, plan C2): the failure digest (`ci-failure-digest.mjs`) answers "why is
// this lane red", but it was only ever reached *after* someone noticed a red lane — the release path
// itself never looked. A release could therefore start on a commit whose lanes were red, cancelled, or
// still running, and nothing in the release output said so.
//
// Two properties are deliberate, for the same reason as the digest:
//   1. every state is named — `all-green`, `red`, `incomplete` (still running or cancelled, which carries
//      no verdict), `no-runs` — so a missing lane can never be read as a green one;
//   2. runs that carry no verdict are listed separately from conclusions, because a cancelled run is
//      what a newer push leaves behind and it is not a failure of this commit.
//
//   node scripts/release-digest-line.mjs [--sha <sha|HEAD>] [--repo owner/name]
//
// Exit codes: 0 all-green or incomplete; 3 no runs for that commit; 4 at least one completed lane red;
//             1 usage or gh failure (nothing here may be read as a pass).

import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

/** Conclusions that are a red lane. `cancelled` is deliberately absent: it carries no verdict. */
const RED_CONCLUSIONS = new Set(['failure', 'timed_out', 'startup_failure', 'action_required'])

/** A run as the Actions API reports it, reduced to what the line needs. */
export const reduceRun = (run) => ({
  name: typeof run?.name === 'string' && run.name ? run.name : 'unnamed-workflow',
  status: typeof run?.status === 'string' && run.status ? run.status : 'unknown',
  conclusion: typeof run?.conclusion === 'string' && run.conclusion ? run.conclusion : 'none',
  id: run?.id === undefined || run?.id === null ? 'none' : String(run.id)
})

/** `name|status|conclusion` — one line per workflow, the shape every CI reading in this repo uses. */
export const formatRunLine = (run) => {
  const r = reduceRun(run)
  return `${r.name}|${r.status}|${r.conclusion}`
}

/**
 * The digest line plus the per-run lines. `verdict` is named, never inferred by a reader:
 * `no-runs` (this commit produced no lanes at all — e.g. a docs-only push, which must not read as green),
 * `red`, `incomplete` (running or cancelled) or `all-green` (every lane completed and succeeded/skipped).
 */
export const summarizeRuns = (runs, sha) => {
  const list = Array.isArray(runs) ? runs.map(reduceRun) : []
  const red = list.filter((r) => r.status === 'completed' && RED_CONCLUSIONS.has(r.conclusion))
  const running = list.filter((r) => r.status !== 'completed')
  const cancelled = list.filter((r) => r.status === 'completed' && r.conclusion === 'cancelled')
  const verdict =
    list.length === 0
      ? 'no-runs'
      : red.length > 0
        ? 'red'
        : running.length + cancelled.length > 0
          ? 'incomplete'
          : 'all-green'
  const shortSha = typeof sha === 'string' && sha.length >= 8 ? sha.slice(0, 8) : 'unknown'
  return {
    verdict,
    shortSha,
    runs: list,
    redRunIds: red.map((r) => r.id),
    lines: list.map((r) => `${r.name}|${r.status}|${r.conclusion}`),
    digestLine:
      `digest: sha=${shortSha} runs=${list.length} red=${red.length} ` +
      `incomplete=${running.length + cancelled.length} verdict=${verdict}`
  }
}

const REPO_DEFAULT = 'naiyixi/PureScience'

const parseArgs = (argv) => {
  const out = { sha: 'HEAD', repo: REPO_DEFAULT }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--sha' && argv[i + 1]) {
      out.sha = argv[(i += 1)]
    } else if (arg === '--repo' && argv[i + 1]) {
      out.repo = argv[(i += 1)]
    } else if (!arg.startsWith('--')) {
      out.sha = arg
    } else {
      throw new Error(`unknown option ${arg}`)
    }
  }
  return out
}

const main = () => {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }

  let sha
  let raw
  try {
    sha = execFileSync('git', ['rev-parse', `${args.sha}^{commit}`], { encoding: 'utf8' }).trim()
    // The full 40-character SHA is required: a short one answers an empty list, which this file would then
    // have to call `no-runs` — the exact misreading that made a red commit look untriggered before.
    raw = execFileSync(
      'gh',
      [
        'api',
        `repos/${args.repo}/actions/runs?head_sha=${sha}&per_page=50`,
        '--jq',
        '.workflow_runs | map({name,status,conclusion,id})'
      ],
      { encoding: 'utf8' }
    )
  } catch (error) {
    console.error(`error: could not read CI runs for ${args.sha} (${String(error).split('\n')[0]})`)
    return 1
  }

  let runs
  try {
    runs = JSON.parse(raw)
  } catch {
    console.error(
      'error: gh returned something that is not JSON; nothing here may be read as a pass'
    )
    return 1
  }

  const summary = summarizeRuns(runs, sha)
  for (const line of summary.lines) console.log(line)
  console.log(summary.digestLine)

  if (summary.verdict === 'no-runs') return 3
  if (summary.verdict === 'red') {
    // Never resolve red here: the digest is what says why, and it stays a separate command so its output
    // can be quoted in a release report.
    console.error(`digest: failing run(s) — rerun: node scripts/ci-failure-digest.mjs <run id>`)
    for (const id of summary.redRunIds) console.error(`digest: red run id ${id}`)
    return 4
  }
  return 0
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = main()
}
