#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */

// 慢 IPC 的「窗口」视角：把一行行 `ipc handler was slow` 归并成真正发生的那几段忙碌窗口。
//
// 为什么需要它（2026-11-03）。通道表是按行汇总的，于是「一次忙碌」会被算成「N 个慢通道」：实测本机
// 五天日志里 read-preview 有 22/59 段突发是多行同一毫秒级完成（5 行总宽 1.2 ms，耗时 84.8/85.4/85.5/
// 86.0/86.0 ms），而同一窗口里还有 session save、notebook state、provenance resolve 一起慢 —— 那是
// 一次窗口，不是五条通道各自慢。按行读表时它表现为「read-preview 中位 482 ms，值得优化」，按窗口读
// 才知道该通道只占全部慢行时间的 0.8%。
//
// 三个不猜的约定：
//   1. 每段窗口的 wall 时间由「窗口首行开始 → 末行完成」推出，并把逐行耗时求和放在旁边：两者相差越大，
//      说明那一段越像并发重叠（求和把同一段时间重复计入，这是逐行汇总的固有偏差，不是产品缺陷）；
//   2. 每个通道判 `window-borne` / `self-borne` 的判据只有一条：它的慢行有多大比例落在「≥3 条慢处理
//      器」的窗口里。阈值与口径都打印在表头上，读者可以换 `--gap` / `--min-peers` 重算；
//   3. 空答案有名字：没有日志文件、日志里没有慢行、日志读不动，各自具名并以非 0 退出 —— 一个什么都没
//      读到的工具不许看起来像一个读完什么都没发现的工具。
//
//   node scripts/slow-ipc-windows.mjs [--log <file> ...] [--exclude <channel> ...] [--gap <ms>]
//                                     [--min-peers <n>] [--top <n>] [--json] [--selftest]
//
// 默认日志：macOS `~/Library/Logs/PureScience/main*.log`；Linux `~/.config/PureScience/logs/main*.log`。
// 退出码：0 已产出报表；1 用法错；2 没有可读的日志文件；3 读到了日志但没有慢行；4 自检失败。

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

const SLOW_IPC_MESSAGE = 'ipc handler was slow'
const DEFAULT_GAP_MS = 1500
const DEFAULT_MIN_PEERS = 3
const DEFAULT_TOP = 8

const usage = () => {
  process.stderr.write(
    [
      'usage: node scripts/slow-ipc-windows.mjs [--log <file> ...] [--exclude <channel> ...] [--gap <ms>]',
      '                                        [--min-peers <n>] [--top <n>] [--json] [--selftest]',
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
  // 轮转文件按名字排序会把 main.10 排到 main.2 前面；行内自带时间戳，排序只影响可读性。
  return files.sort()
}

/**
 * 一行日志 → 一条慢行，或 undefined。字段缺失的行同样返回 undefined：`durationMs` 缺失时把它当 0
 * 会让一条读不动的行冒充一条很快的行。
 */
const parseRow = (line) => {
  if (!line.includes(SLOW_IPC_MESSAGE)) return undefined
  let record
  try {
    record = JSON.parse(line)
  } catch {
    return undefined
  }
  const data = record && typeof record === 'object' ? record.data : undefined
  if (!data || typeof data !== 'object') return undefined
  const duration = data.durationMs
  const channel = data.channel
  if (typeof duration !== 'number' || !Number.isFinite(duration)) return undefined
  if (typeof channel !== 'string' || channel.length === 0) return undefined
  const at = Date.parse(record.t)
  if (!Number.isFinite(at)) return undefined
  return { at, channel, durationMs: duration }
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

/**
 * 归并窗口：一条慢行只要与窗口内上一条的完成时刻相差不超过 `gapMs`，就属于同一段。用「上一条」而不是
 * 「窗口起点」，是因为一段长窗口里的行可以相隔几秒却仍连着（当时的循环一直被占着）。
 */
const groupWindows = (rows, gapMs) => {
  const windows = []
  let current = []
  for (const row of rows) {
    if (current.length === 0) {
      current = [row]
      continue
    }
    if (row.at - current[current.length - 1].at <= gapMs) {
      current.push(row)
    } else {
      windows.push(current)
      current = [row]
    }
  }
  if (current.length > 0) windows.push(current)
  return windows
}

const median = (values) => {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

const sum = (values) => values.reduce((total, value) => total + value, 0)

const round = (value) => Math.round(value * 10) / 10

/** 报表的唯一数据源：纯函数，自检直接对它断言。 */
const analyse = (rows, { gapMs = DEFAULT_GAP_MS, minPeers = DEFAULT_MIN_PEERS } = {}) => {
  const windows = groupWindows(rows, gapMs)
  const peerWindows = windows.filter((window) => window.length >= minPeers)
  const rowsInsidePeerWindows = sum(peerWindows.map((window) => window.length))
  const perChannel = new Map()
  for (const window of windows) {
    const peers = window.length
    for (const row of window) {
      const entry = perChannel.get(row.channel) ?? {
        channel: row.channel,
        count: 0,
        totalMs: 0,
        durations: [],
        insidePeerWindows: 0
      }
      entry.count += 1
      entry.totalMs += row.durationMs
      entry.durations.push(row.durationMs)
      if (peers >= minPeers) entry.insidePeerWindows += 1
      perChannel.set(row.channel, entry)
    }
  }
  const channels = [...perChannel.values()]
    .map((entry) => {
      const peerShare = entry.count === 0 ? 0 : entry.insidePeerWindows / entry.count
      return {
        channel: entry.channel,
        count: entry.count,
        totalMs: round(entry.totalMs),
        medianMs: round(median(entry.durations)),
        maxMs: round(Math.max(...entry.durations)),
        peerShare: round(peerShare),
        // Exactly half is named `mixed` instead of being rounded into one side: a channel whose slow rows
        // split evenly between busy windows and its own work has no majority, and calling either way would
        // invent one.
        verdict: peerShare > 0.5 ? 'window-borne' : peerShare < 0.5 ? 'self-borne' : 'mixed'
      }
    })
    .sort((a, b) => b.totalMs - a.totalMs)
  const totalSlowMs = sum(rows.map((row) => row.durationMs))
  const windowReports = windows
    .map((window) => {
      const channelsInWindow = new Map()
      for (const row of window) {
        channelsInWindow.set(row.channel, (channelsInWindow.get(row.channel) ?? 0) + 1)
      }
      return {
        startedAt: new Date(window[0].at).toISOString(),
        finishedAt: new Date(window[window.length - 1].at).toISOString(),
        spanMs: round(window[window.length - 1].at - window[0].at),
        handlers: window.length,
        distinctChannels: channelsInWindow.size,
        summedMs: round(sum(window.map((row) => row.durationMs))),
        topChannels: [...channelsInWindow.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([channel, count]) => `${channel}×${count}`)
      }
    })
    .sort((a, b) => b.summedMs - a.summedMs)

  return {
    rows: rows.length,
    windows: windows.length,
    gapMs,
    minPeers,
    totalSlowMs: round(totalSlowMs),
    peerWindowCount: peerWindows.length,
    rowsInsidePeerWindows,
    rowsInsidePeerWindowsShare: rows.length === 0 ? 0 : round(rowsInsidePeerWindows / rows.length),
    channels,
    windowReports
  }
}

const formatReport = (report, top) => {
  const lines = []
  lines.push(
    `slow-ipc windows | rows=${report.rows} windows=${report.windows} gap=${report.gapMs}ms min-peers=${report.minPeers}`
  )
  lines.push(
    `slow rows inside windows with >=${report.minPeers} handlers: ${report.rowsInsidePeerWindows}/${report.rows} (${Math.round(
      report.rowsInsidePeerWindowsShare * 100
    )}%) | summed slow time ${Math.round(report.totalSlowMs)} ms`
  )
  lines.push('')
  lines.push('per channel (sorted by summed duration):')
  lines.push(
    '  channel'.padEnd(36) +
      'n'.padStart(6) +
      'sumMs'.padStart(12) +
      'share'.padStart(8) +
      'median'.padStart(10) +
      'max'.padStart(10) +
      '  verdict'
  )
  for (const entry of report.channels) {
    const share = report.totalSlowMs === 0 ? 0 : (entry.totalMs / report.totalSlowMs) * 100
    lines.push(
      `  ${entry.channel}`.padEnd(38) +
        String(entry.count).padStart(5) +
        String(Math.round(entry.totalMs)).padStart(12) +
        `${share.toFixed(1)}%`.padStart(8) +
        entry.medianMs.toFixed(1).padStart(11) +
        entry.maxMs.toFixed(1).padStart(12) +
        `   ${entry.verdict} (peer rows ${Math.round(entry.peerShare * 100)}%)`
    )
  }
  lines.push('')
  lines.push(`biggest windows by summed duration (top ${top}):`)
  for (const window of report.windowReports.slice(0, top)) {
    lines.push(
      `  ${window.startedAt} span=${Math.round(window.spanMs)}ms handlers=${window.handlers} channels=${window.distinctChannels} summed=${Math.round(window.summedMs)}ms ${window.topChannels.join(' ')}`
    )
  }
  lines.push('')
  lines.push(
    'read me: `summed` counts concurrent handlers separately, so a window where five handlers overlap reports'
  )
  lines.push(
    "roughly five times the wall time it actually blocked; `window-borne` means most of that channel's slow"
  )
  lines.push(
    'rows landed in such a window, i.e. the window is the unit to investigate, not the channel.'
  )
  return lines.join('\n')
}

const parseArgs = (argv) => {
  const options = {
    logs: [],
    excluded: [],
    gapMs: DEFAULT_GAP_MS,
    minPeers: DEFAULT_MIN_PEERS,
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
    } else if (argument === '--exclude') {
      const value = argv[index + 1]
      if (!value) return undefined
      options.excluded.push(value)
      index += 1
    } else if (argument === '--gap') {
      const value = Number(argv[index + 1])
      if (!Number.isFinite(value) || value < 0) return undefined
      options.gapMs = value
      index += 1
    } else if (argument === '--min-peers') {
      const value = Number(argv[index + 1])
      if (!Number.isInteger(value) || value < 1) return undefined
      options.minPeers = value
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

// 自检：用固定夹具钉住「窗口归并」「peer 占比」「空答案具名」三件事，因为这三件出错时报表仍然好看。
const selftest = () => {
  const fixtures = [
    { t: '2026-01-01T00:00:00.000Z', data: { channel: 'a', durationMs: 100 } },
    { t: '2026-01-01T00:00:00.001Z', data: { channel: 'b', durationMs: 120 } },
    { t: '2026-01-01T00:00:00.002Z', data: { channel: 'c', durationMs: 90 } },
    { t: '2026-01-01T00:10:00.000Z', data: { channel: 'a', durationMs: 80 } },
    { t: '2026-01-01T00:20:00.000Z', data: { channel: 'd', durationMs: 70 } }
  ]
  const rows = fixtures.map((fixture) =>
    parseRow(JSON.stringify({ msg: SLOW_IPC_MESSAGE, ...fixture }))
  )
  const problems = []
  if (rows.some((row) => row === undefined)) problems.push('fixture rows must all parse')
  const report = analyse(rows, { gapMs: 1500, minPeers: 3 })
  if (report.windows !== 3) problems.push(`expected 3 windows, got ${report.windows}`)
  if (report.peerWindowCount !== 1)
    problems.push(`expected 1 peer window, got ${report.peerWindowCount}`)
  if (report.rowsInsidePeerWindows !== 3)
    problems.push(`expected 3 peer rows, got ${report.rowsInsidePeerWindows}`)
  const byChannel = new Map(report.channels.map((entry) => [entry.channel, entry]))
  if (byChannel.get('b')?.verdict !== 'window-borne') problems.push('b must be window-borne')
  if (byChannel.get('a')?.verdict !== 'mixed')
    problems.push('a must be mixed (half its rows in a busy window)')
  if (byChannel.get('d')?.verdict !== 'self-borne') problems.push('d must be self-borne')
  if (report.totalSlowMs !== 460) problems.push(`expected 460 ms total, got ${report.totalSlowMs}`)
  if (report.windowReports[0]?.handlers !== 3)
    problems.push('the busiest window must be listed first')
  if (parseRow('{"msg":"ipc handler was slow","data":{"channel":"a"}}') !== undefined) {
    problems.push('a row without durationMs must not parse as a 0 ms row')
  }
  if (analyse([], {}).totalSlowMs !== 0) problems.push('empty input must report 0 total ms')
  if (problems.length > 0) {
    process.stderr.write(`selftest FAILED:\n  ${problems.join('\n  ')}\n`)
    return 4
  }
  process.stdout.write(
    'selftest OK (window grouping, three-way peer verdict, missing-duration rejection, empty input)\n'
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
      'no-slow-rows: the logs carry no `ipc handler was slow` line (nothing here is a pass).\n'
    )
    return 3
  }

  // A channel that spans a whole agent turn (`acp:send-prompt`) reports the turn's length as one slow row, so
  // its share is turn time and not blocked main time. Excluding is explicit and counted: a reader can tell
  // "there was nothing to exclude" from "the exclusion took effect".
  const excludedCounts = new Map()
  const kept = rows.filter((row) => {
    if (!options.excluded.includes(row.channel)) return true
    excludedCounts.set(row.channel, (excludedCounts.get(row.channel) ?? 0) + 1)
    return false
  })
  for (const [channel, count] of excludedCounts) {
    process.stderr.write(`excluded: ${channel} (${count} row(s))\n`)
  }
  for (const channel of options.excluded) {
    if (!excludedCounts.has(channel))
      process.stderr.write(`excluded: ${channel} (0 row(s) — nothing matched)\n`)
  }
  if (kept.length === 0) {
    process.stderr.write(
      'no-slow-rows: every slow row was excluded by --exclude (nothing here is a pass).\n'
    )
    return 3
  }

  const report = analyse(kept, { gapMs: options.gapMs, minPeers: options.minPeers })
  process.stdout.write(
    options.json ? `${JSON.stringify(report, null, 2)}\n` : `${formatReport(report, options.top)}\n`
  )
  return 0
}

process.exit(main())
