#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */

// 事件循环停摆的「归因」读数：把 `event loop stalled` 行按成因、按主机压力、按采样帧聚合，
// 并把**采样帧能解释多少停摆墙钟时间**单独打出来。
//
// 为什么需要它（2026-11-03）。停摆行里带一份采样剖面（`stack.frames`），看起来像「谁占着循环」的答案。
// 但 V8 采样器只有在进程**重新跑起来之后**才会继续出样本：实测一条 87.9 s 的停摆里 `unobservedMs`
// 占 90%，而 `samples` 只有 128 个 —— 于是 `frames` 记的是「循环回来以后先跑了什么」，不是「谁把它占住了」。
// 只看 `frames[].samples` 的绝对数会把人送到一个无辜的函数上（本机实测：样本数第一的
// `renderAppMcpToolReferences` 真实成本 0.06–0.16 ms/次，却出现在几乎所有停摆事件里，平均每事件 ≈1 个样本）。
//
// 所以这份报表的每一行都并排给出三样东西：事件数、样本数、以及该帧样本占**已观测主线程时间**的比例，
// 再加一行「已观测 / 停摆墙钟」的总账。二者差得越大，读帧表时越要把它当「停摆后的恢复工作」。
//
//   node scripts/stall-profile-report.mjs [--log <file> ...] [--since <YYYY-MM-DD>]
//                                         [--min-window-ms <n>] [--top <n>] [--json] [--selftest]
//
// 默认日志：macOS `~/Library/Logs/PureScience/main*.log`；Linux `~/.config/PureScience/logs/main*.log`。
// 退出码：0 已产出报表；1 用法错；2 没有可读的日志文件；3 读到了日志但没有停摆行；4 自检失败。

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

const STALL_MESSAGE = 'event loop stalled'
const DEFAULT_TOP = 10

const usage = () => {
  process.stderr.write(
    [
      'usage: node scripts/stall-profile-report.mjs [--log <file> ...] [--since <YYYY-MM-DD>]',
      '                                           [--min-window-ms <n>] [--top <n>] [--json] [--selftest]',
      ''
    ].join('\n')
  )
}

const defaultLogFiles = () => {
  const candidates =
    process.platform === 'darwin'
      ? [join(homedir(), 'Library', 'Logs', 'PureScience')]
      : [join(homedir(), '.config', 'PureScience', 'logs')]
  const files = []
  for (const dir of candidates) {
    if (!existsSync(dir)) continue
    for (const entry of readdirSync(dir)) {
      if (/^main(\.\d+)?\.log$/.test(entry)) files.push(join(dir, entry))
    }
  }
  return files.sort()
}

const numberOrUndefined = (value) =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

/**
 * 一行日志 → 一条停摆事件，或 undefined。缺 `windowMs` 的行不解析：把它当 0 ms 会让一条读不动的行
 * 冒充一次「很短的停摆」，而这份报表正是按窗口宽度排序的。
 */
const parseRow = (line) => {
  if (!line.includes(STALL_MESSAGE)) return undefined
  let record
  try {
    record = JSON.parse(line)
  } catch {
    return undefined
  }
  const data = record && typeof record === 'object' ? record.data : undefined
  if (!data || typeof data !== 'object') return undefined
  const windowMs = numberOrUndefined(data.windowMs)
  if (windowMs === undefined || windowMs <= 0) return undefined
  const at = Date.parse(record.t)
  if (!Number.isFinite(at)) return undefined
  const stack = data.stack && typeof data.stack === 'object' ? data.stack : undefined
  const cause = data.cause && typeof data.cause === 'object' ? data.cause : undefined
  const host = data.host && typeof data.host === 'object' ? data.host : undefined
  const frames = []
  if (stack && Array.isArray(stack.frames)) {
    for (const frame of stack.frames) {
      if (!frame || typeof frame !== 'object') continue
      if (typeof frame.frame !== 'string' || frame.frame.length === 0) continue
      const samples = numberOrUndefined(frame.samples) ?? 0
      frames.push({ frame: frame.frame, samples })
    }
  }
  return {
    at,
    windowMs,
    cpuShare: numberOrUndefined(data.cpuShare),
    causeKind: cause && typeof cause.kind === 'string' ? cause.kind : undefined,
    causeBasis: cause && typeof cause.basis === 'string' ? cause.basis : undefined,
    stackStatus: stack && typeof stack.status === 'string' ? stack.status : undefined,
    mainThreadMs: stack ? numberOrUndefined(stack.mainThreadMs) : undefined,
    unobservedMs: stack ? numberOrUndefined(stack.unobservedMs) : undefined,
    samples: stack ? numberOrUndefined(stack.samples) : undefined,
    frames,
    loadAvg1mMax: host ? numberOrUndefined(host.loadAvg1mMax) : undefined,
    swapouts: host ? numberOrUndefined(host.swapouts) : undefined,
    freeMemMbMin: host ? numberOrUndefined(host.freeMemMbMin) : undefined
  }
}

const readRows = (files) => {
  const rows = []
  const unreadable = []
  for (const file of files) {
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch (error) {
      unreadable.push({ file, reason: error instanceof Error ? error.message : String(error) })
      continue
    }
    for (const line of text.split('\n')) {
      const row = parseRow(line)
      if (row) rows.push(row)
    }
  }
  rows.sort((a, b) => a.at - b.at)
  return { rows, unreadable }
}

const sum = (values) => values.reduce((total, value) => total + value, 0)
const round = (value) => Math.round(value * 100) / 100

const percentile = (values, share) => {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * share))
  return sorted[index]
}

const median = (values) => percentile(values, 0.5)

/** 报表的唯一数据源：纯函数，自检直接对它断言。 */
const analyse = (rows) => {
  const byDay = new Map()
  const causes = new Map()
  for (const row of rows) {
    const day = new Date(row.at).toISOString().slice(0, 10)
    byDay.set(day, (byDay.get(day) ?? 0) + 1)
    const kind = row.causeKind ?? 'not-recorded'
    causes.set(kind, (causes.get(kind) ?? 0) + 1)
  }

  const windowMs = rows.map((row) => row.windowMs)
  const totalWindowMs = sum(windowMs)
  const mainThreadValues = rows
    .map((row) => row.mainThreadMs)
    .filter((value) => value !== undefined)
  const unobservedValues = rows
    .map((row) => row.unobservedMs)
    .filter((value) => value !== undefined)
  const totalMainThreadMs = sum(mainThreadValues)
  const totalUnobservedMs = sum(unobservedValues)
  const cpuShares = rows.map((row) => row.cpuShare).filter((value) => value !== undefined)

  // 每条停摆里「样本最多的那一帧」也算一次票：它回答「这条停摆里被记到最多的是谁」，
  // 与按样本总数排序互补（少数超长停摆可以把总数拉偏）。
  const perFrame = new Map()
  let eventsWithFrames = 0
  let eventsWithoutFrames = 0
  for (const row of rows) {
    if (row.frames.length === 0) {
      eventsWithoutFrames += 1
      continue
    }
    eventsWithFrames += 1
    let topFrame
    for (const frame of row.frames) {
      const entry = perFrame.get(frame.frame) ?? {
        frame: frame.frame,
        samples: 0,
        events: 0,
        topInEvents: 0
      }
      entry.samples += frame.samples
      entry.events += 1
      perFrame.set(frame.frame, entry)
      if (!topFrame || frame.samples > topFrame.samples) topFrame = frame
    }
    if (topFrame) {
      const entry = perFrame.get(topFrame.frame)
      entry.topInEvents += 1
    }
  }
  const totalFrameSamples = sum([...perFrame.values()].map((entry) => entry.samples))
  const frames = [...perFrame.values()]
    .map((entry) => ({
      frame: entry.frame,
      samples: entry.samples,
      events: entry.events,
      topInEvents: entry.topInEvents,
      samplesPerEvent: round(entry.samples / entry.events),
      // 样本只是**已观测**时间里的一票；用它去解释停摆墙钟时，要先过 observedShare 这一关。
      sampleShare: totalFrameSamples === 0 ? 0 : round(entry.samples / totalFrameSamples)
    }))
    .sort((a, b) => b.samples - a.samples)

  const hostValues = rows.filter((row) => row.loadAvg1mMax !== undefined)
  const swapValues = rows.map((row) => row.swapouts).filter((value) => value !== undefined)
  const freeValues = rows.map((row) => row.freeMemMbMin).filter((value) => value !== undefined)

  return {
    events: rows.length,
    days: [...byDay.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([day, count]) => ({ day, count })),
    causes: [...causes.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([kind, count]) => ({ kind, count })),
    windowMs: {
      totalMs: round(totalWindowMs),
      medianMs: round(median(windowMs)),
      p90Ms: round(percentile(windowMs, 0.9)),
      maxMs: round(windowMs.length === 0 ? 0 : Math.max(...windowMs))
    },
    observation: {
      eventsWithFrames,
      eventsWithoutFrames,
      totalMainThreadMs: round(totalMainThreadMs),
      totalUnobservedMs: round(totalUnobservedMs),
      // 这一格是整份报表的重点：采样帧能解释的份额。
      observedShare: totalWindowMs === 0 ? 0 : round(totalMainThreadMs / totalWindowMs),
      unobservedShare: totalWindowMs === 0 ? 0 : round(totalUnobservedMs / totalWindowMs),
      medianCpuShare: round(median(cpuShares))
    },
    host: {
      rowsWithHostMetrics: hostValues.length,
      maxLoadAvg1m:
        hostValues.length === 0
          ? undefined
          : round(Math.max(...hostValues.map((row) => row.loadAvg1mMax))),
      totalSwapouts: swapValues.length === 0 ? undefined : sum(swapValues),
      minFreeMemMb: freeValues.length === 0 ? undefined : Math.min(...freeValues)
    },
    frames
  }
}

const formatReport = (report, top) => {
  const lines = []
  lines.push(
    `event-loop stalls | events=${report.events} windowTotal=${(report.windowMs.totalMs / 1000).toFixed(1)}s ` +
      `median=${Math.round(report.windowMs.medianMs)}ms p90=${Math.round(report.windowMs.p90Ms)}ms max=${Math.round(
        report.windowMs.maxMs
      )}ms`
  )
  lines.push(
    `observed / stalled wall time: ${(report.observation.totalMainThreadMs / 1000).toFixed(1)}s of ` +
      `${(report.windowMs.totalMs / 1000).toFixed(1)}s (${Math.round(report.observation.observedShare * 100)}%) — ` +
      `the remaining ${Math.round(report.observation.unobservedShare * 100)}% the process was not running, so no frame can explain it`
  )
  lines.push(
    `frames: ${report.observation.eventsWithFrames} event(s) carry a profile, ${report.observation.eventsWithoutFrames} do not | median cpuShare ${report.observation.medianCpuShare}`
  )
  lines.push(`by day: ${report.days.map((entry) => `${entry.day}=${entry.count}`).join(' ')}`)
  lines.push('')
  lines.push('causes:')
  for (const cause of report.causes)
    lines.push(`  ${cause.kind.padEnd(22)} ${String(cause.count).padStart(6)}`)
  if (report.host.rowsWithHostMetrics > 0) {
    lines.push('')
    lines.push(
      `host: ${report.host.rowsWithHostMetrics} row(s) carry metrics | max loadAvg1m ${report.host.maxLoadAvg1m} | ` +
        `swapouts total ${report.host.totalSwapouts} | min freeMemMb ${report.host.minFreeMemMb}`
    )
  }
  lines.push('')
  lines.push(`top frames by samples (top ${top}):`)
  lines.push(
    '  frame'.padEnd(64) +
      'events'.padStart(8) +
      'samples'.padStart(9) +
      'perEvent'.padStart(10) +
      'topIn'.padStart(7) +
      'share'.padStart(8)
  )
  for (const frame of report.frames.slice(0, top)) {
    lines.push(
      `  ${frame.frame}`.padEnd(66) +
        String(frame.events).padStart(7) +
        String(frame.samples).padStart(9) +
        frame.samplesPerEvent.toFixed(2).padStart(10) +
        String(frame.topInEvents).padStart(7) +
        `${Math.round(frame.sampleShare * 100)}%`.padStart(8)
    )
  }
  lines.push('')
  lines.push(
    'read me: samples are taken while the loop is running, so a frame with ~1 sample in almost every event is'
  )
  lines.push(
    'the work that resumed after the stall, not the thing that held it. Read the observed share first; a frame'
  )
  lines.push('can only explain the observed part, and only if its own cost accounts for it.')
  return lines.join('\n')
}

const parseArgs = (argv) => {
  const options = {
    logs: [],
    since: undefined,
    minWindowMs: undefined,
    top: DEFAULT_TOP,
    json: false,
    selftest: false
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--selftest') options.selftest = true
    else if (argument === '--json') options.json = true
    else if (argument === '--log') {
      const value = argv[index + 1]
      if (!value) return undefined
      options.logs.push(value)
      index += 1
    } else if (argument === '--since') {
      const value = argv[index + 1]
      if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined
      options.since = value
      index += 1
    } else if (argument === '--min-window-ms') {
      const value = Number(argv[index + 1])
      if (!Number.isFinite(value) || value < 0) return undefined
      options.minWindowMs = value
      index += 1
    } else if (argument === '--top') {
      const value = Number(argv[index + 1])
      if (!Number.isInteger(value) || value < 1) return undefined
      options.top = value
      index += 1
    } else if (argument === '--help' || argument === '-h') return undefined
    else return undefined
  }
  return options
}

// 自检：钉住「观测份额的算法」「逐事件票数」「缺 windowMs 的行不许当 0 ms」，这三件错了报表照样好看。
const selftest = () => {
  const fixtures = [
    {
      t: '2026-01-01T00:00:00.000Z',
      data: {
        windowMs: 1000,
        cpuShare: 0.5,
        cause: { kind: 'fs-queue-saturated', basis: 'canary 5000 ms' },
        stack: {
          status: 'profiled',
          mainThreadMs: 200,
          unobservedMs: 800,
          samples: 10,
          frames: [
            { frame: 'innocent (out/main/a.js:1)', samples: 6 },
            { frame: 'holder (out/main/b.js:2)', samples: 4 }
          ]
        },
        host: { loadAvg1mMax: 12, swapouts: 100, freeMemMbMin: 40 }
      }
    },
    {
      t: '2026-01-02T00:00:00.000Z',
      data: {
        windowMs: 3000,
        cpuShare: 0.9,
        cause: { kind: 'cpu-in-process', basis: 'cpuShare 0.9' },
        stack: {
          status: 'profiled',
          mainThreadMs: 2700,
          unobservedMs: 300,
          samples: 40,
          frames: [{ frame: 'holder (out/main/b.js:2)', samples: 40 }]
        }
      }
    },
    { t: '2026-01-02T01:00:00.000Z', data: { windowMs: 500 } }
  ]
  const rows = fixtures.map((fixture) =>
    parseRow(JSON.stringify({ msg: STALL_MESSAGE, ...fixture }))
  )
  const problems = []
  if (rows.some((row) => row === undefined)) problems.push('fixture rows must all parse')
  const report = analyse(rows)
  if (report.events !== 3) problems.push(`expected 3 events, got ${report.events}`)
  if (report.windowMs.totalMs !== 4500)
    problems.push(`expected 4500 ms total, got ${report.windowMs.totalMs}`)
  // 已观测 = 200 + 2700 = 2900 / 4500 = 0.6444
  if (Math.abs(report.observation.observedShare - 0.64) > 0.01)
    problems.push(`expected observedShare ~0.64, got ${report.observation.observedShare}`)
  if (report.observation.eventsWithoutFrames !== 1)
    problems.push('the event without a profile must be counted, not hidden')
  const byFrame = new Map(report.frames.map((entry) => [entry.frame, entry]))
  const innocent = byFrame.get('innocent (out/main/a.js:1)')
  const holder = byFrame.get('holder (out/main/b.js:2)')
  if (!innocent || !holder) problems.push('both fixture frames must be listed')
  else {
    if (holder.topInEvents !== 1)
      problems.push(`holder must top 1 event, got ${holder.topInEvents}`)
    if (innocent.topInEvents !== 1)
      problems.push(`innocent must top 1 event, got ${innocent.topInEvents}`)
    if (innocent.events !== 1)
      problems.push(`innocent must appear in 1 event, got ${innocent.events}`)
  }
  // 第三条夹具没有 cause ⇒ 具名成 `not-recorded`，不许静默并入别的成因。
  if (report.causes.length !== 3)
    problems.push(`expected 3 cause kinds (two named + not-recorded), got ${report.causes.length}`)
  if (!report.causes.some((cause) => cause.kind === 'not-recorded'))
    problems.push('a stall without a cause must be named not-recorded')
  if (report.host.rowsWithHostMetrics !== 1)
    problems.push('host metrics are counted per row that carries them')
  if (parseRow('{"msg":"event loop stalled","data":{"stack":{}}}') !== undefined)
    problems.push('a row without windowMs must not parse as a 0 ms stall')
  if (analyse([]).events !== 0) problems.push('empty input must report zero events')
  if (analyse([]).observation.observedShare !== 0)
    problems.push('empty input must not divide by zero')
  if (problems.length > 0) {
    process.stderr.write(`selftest FAILED:\n  ${problems.join('\n  ')}\n`)
    return 4
  }
  process.stdout.write(
    'selftest OK (observed-share math, per-event top vote, events without a profile, missing-windowMs rejection, empty input)\n'
  )
  return 0
}

const main = () => {
  const options = parseArgs(process.argv.slice(2))
  if (!options) {
    usage()
    return 1
  }
  if (options.selftest) return selftest()

  const files = options.logs.length > 0 ? options.logs : defaultLogFiles()
  if (files.length === 0) {
    process.stderr.write(
      'no-log-files: nothing to read. Pass --log <file> (the app writes main*.log under the platform log directory).\n'
    )
    return 2
  }
  for (const file of files) {
    if (!existsSync(file)) {
      process.stderr.write(`no-log-files: ${file} does not exist\n`)
      return 2
    }
  }

  const { rows, unreadable } = readRows(files)
  process.stderr.write(`files: ${files.map((file) => basename(file)).join(', ')}\n`)
  for (const entry of unreadable)
    process.stderr.write(`unreadable: ${entry.file} (${entry.reason})\n`)
  if (rows.length === 0) {
    process.stderr.write(
      'no-stall-rows: the logs carry no `event loop stalled` line (nothing here is a pass).\n'
    )
    return 3
  }

  let kept = rows
  if (options.since) {
    const sinceAt = Date.parse(`${options.since}T00:00:00.000Z`)
    const before = kept.length
    kept = kept.filter((row) => row.at >= sinceAt)
    process.stderr.write(`since: ${options.since} (${before - kept.length} row(s) dropped)\n`)
  }
  if (options.minWindowMs !== undefined) {
    const before = kept.length
    kept = kept.filter((row) => row.windowMs >= options.minWindowMs)
    process.stderr.write(
      `min-window-ms: ${options.minWindowMs} (${before - kept.length} row(s) dropped)\n`
    )
  }
  if (kept.length === 0) {
    process.stderr.write('no-stall-rows: every stall was filtered out (nothing here is a pass).\n')
    return 3
  }

  const report = analyse(kept)
  process.stdout.write(
    options.json ? `${JSON.stringify(report, null, 2)}\n` : `${formatReport(report, options.top)}\n`
  )
  return 0
}

process.exit(main())
