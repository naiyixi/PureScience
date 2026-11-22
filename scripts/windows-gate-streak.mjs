#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */
// 发版前的 Windows 车道闸门：读 Nightly 的 windows job 读数，数「连续几次通过」。
//
// 判据（2026-11-22 拍板）：
//   * 单位是 **windows job 的读数**，不是整趟 run —— 一趟 run 可能因为别的平台偶发红而整趟失败，
//     那不是 Windows 的证据；
//   * 被取消、或根本没跑到 windows job 的 run **不算**（既不算绿也不算红，跳过），因为「推送顶掉了
//     在跑的那趟」是本仓库最常见的形态，用它打断连续数是把运气当判据；
//   * 读到一次 `electron P0 reading: failed` 或 job 失败，连续计数归零 —— 一条链只从最新往回数。
//
// 用法：
//   node scripts/windows-gate-streak.mjs                 # 打印连续数，够 3 则退出码 0
//   node scripts/windows-gate-streak.mjs --need 3 --json # 机器可读
//   node scripts/windows-gate-streak.mjs --repo naiyixi/PureScience --token "$GITHUB_TOKEN"
//
// 在 release.yml 的 preflight 里跑它：Nightly 的 windows 车道没攒够就不发版。注意 release.yml 自己的
// `windows-upgrade-smoke` **不能**放进 `publish.needs` —— 它 depends on publish（要读已发布的资产），
// 那是一个依赖环。所以闸门读的是 Nightly 的证据，不是发版时那一趟。
import { argv, env, exit } from 'node:process'

const option = (name, fallback) => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback
}
const flag = (name) => argv.includes(`--${name}`)

const repo = option('repo', env.GITHUB_REPOSITORY ?? 'naiyixi/PureScience')
const token = option('token', env.GITHUB_TOKEN ?? '')
const need = Number(option('need', '3'))
const limit = Number(option('limit', '12'))

const api = async (path) => {
  const response = await fetch(`https://api.github.com/repos/${repo}${path}`, {
    headers: {
      accept: 'application/vnd.github+json',
      ...(token ? { authorization: `Bearer ${token}` } : {})
    }
  })
  if (!response.ok) throw new Error(`GitHub answered ${response.status} for ${path}`)
  return response.json()
}

const jobLog = async (jobId) => {
  const response = await fetch(`https://api.github.com/repos/${repo}/actions/jobs/${jobId}/logs`, {
    headers: {
      accept: 'application/vnd.github+json',
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    redirect: 'follow'
  })
  if (!response.ok) throw new Error(`GitHub answered ${response.status} for job ${jobId} logs`)
  return response.text()
}

// 读数是 job 自己打印的那一行：`electron P0 reading: passed`。它比 job 的 conclusion 更具体 ——
// 一个 success 的 job 也可能在 P0 之前的步骤被跳过，而这个文件要的是「P0 真的跑过并被读过」。
export const readingOf = (log) => {
  // Every line arrives timestamped (`2026-11-22T13:39:48.50Z electron P0 reading: passed`), and the step's
  // own `echo "electron P0 reading: $electron_p0"` sits in the log above the real output — so a bare
  // first-match regex reads `$electron_p0` as the answer. Take the last match whose value is a state.
  const matches = [...log.matchAll(/electron P0 reading: (\S+)/g)].map((match) => match[1])
  const states = matches.filter((value) => value === 'passed' || value === 'failed')
  return states.length > 0 ? states[states.length - 1] : undefined
}

export const computeWindowsStreak = (entries, need = 3) => {
  let streak = 0
  const credited = []
  const skipped = []
  for (const entry of entries) {
    if (entry.reading === undefined) {
      skipped.push({ runId: entry.runId, reason: entry.reason ?? 'no reading' })
      continue
    }
    if (entry.reading !== 'passed') {
      skipped.push({ runId: entry.runId, reason: `reading=${entry.reading}` })
      break
    }
    streak += 1
    credited.push(entry.runId)
    if (streak >= need) break
  }
  return { streak, need, satisfied: streak >= need, credited, skipped }
}

const main = async () => {
  const runs = await api(`/actions/workflows/nightly.yml/runs?per_page=${limit}`)
  const entries = []
  for (const run of runs.workflow_runs ?? []) {
    const jobs = await api(`/actions/runs/${run.id}/jobs?per_page=30`)
    const windows = (jobs.jobs ?? []).find((job) => /Build windows-x64/.test(job.name))
    if (!windows) {
      entries.push({ runId: run.id, reading: undefined, reason: 'no windows job' })
      continue
    }
    if (windows.status !== 'completed' || windows.conclusion !== 'success') {
      entries.push({
        runId: run.id,
        reading: windows.conclusion === 'failure' ? 'failed' : undefined,
        reason: `job ${windows.conclusion ?? windows.status}`
      })
      continue
    }
    const reading = readingOf(await jobLog(windows.id))
    entries.push({
      runId: run.id,
      reading,
      reason: reading ? undefined : 'job succeeded, no reading line'
    })
  }

  const result = computeWindowsStreak(entries, need)
  if (flag('json')) {
    console.log(JSON.stringify({ ...result, entries }, null, 2))
  } else {
    console.log(
      `windows gate streak: ${result.streak}/${result.need} ` +
        `(${result.satisfied ? 'satisfied' : 'not yet'})`
    )
    if (result.credited.length) console.log(`  credited: ${result.credited.join(', ')}`)
    for (const skip of result.skipped) console.log(`  skipped: ${skip.runId} — ${skip.reason}`)
  }
  exit(result.satisfied ? 0 : 1)
}

if (import.meta.url === `file://${argv[1]}`) {
  main().catch((error) => {
    console.error(`windows gate streak: ${error instanceof Error ? error.message : String(error)}`)
    exit(2)
  })
}
