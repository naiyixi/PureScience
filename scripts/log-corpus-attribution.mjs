#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */

// 日志语料的「归属」视角：先回答每一行属于哪个实例、属于真实会话还是认证夹具，再报错误族。
//
// 为什么需要它（2026-11-12，实测代价）。按 `msg` 直接聚合六份 `main*.log` 会得到一张看起来很严重的表：
// `review protocol incomplete` **2,670 行**（error）。逐行看 `sessionId` 才发现它们**全部**是
// `e2e-session-*`——认证车道用假 agent 驱动的夹具会话，夹具的约定就是「不调 submit_findings」，
// 于是那一族错误是**预期的**，一次都没发生在打包版上（同一族在 `PureScience/` 三份日志里 = 0 行）。
// 换句话说：不切归属，语料会把一条夹具约定报成产品缺陷，而真正要看的那几族会被它埋掉。
//
// 三种归属，缺一不可（第三态不许并进前两态）：
//   - `fixture`      会话 id 以 `e2e` 开头（认证/夹具会话）
//   - `real`         会话 id 在场且不是夹具
//   - `unattributed` 行上没有任何会话 id（说不出归属就没有归属，不许默认成 real）
//
// 实例归属只取自**文件所在目录名**（`PureScience` / `PureScience (DEV)` / …）：日志自己不带实例名，
// 而目录名是唯一非推断的来源。
//
// `--recurrence` 再加一层：同一条失败**被同一个身份重复撞了 N 次**，还是只撞了一次？这一个数决定
// 「要不要给它加有界重试」这类问题该不该立项——已经重试过 15 次的族再加一层重试，只会把代价乘上去。
//
//   node scripts/log-corpus-attribution.mjs [--log <file> ...] [--top <n>] [--json] [--recurrence] [--selftest]
//
// 退出码：0 已产出报表；1 用法错；2 没有可读的日志文件；3 读到了文件但没有任何可解析行；4 自检失败。

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SLOW_IPC_MESSAGE = 'ipc handler was slow'
// A stall row is not one thing: its `cause.kind` names what held the loop, and `process-frozen` means no thread
// of this process ran at all (sleep, an external stop, total starvation) — a window that belongs to the machine.
const STALL_MESSAGE = 'event loop stalled'
const FROZEN_CAUSE = 'process-frozen'
// 判「整进程没在跑」的那道门住在生产者里（`src/main/diagnostics/stall-cause.ts`，`FROZEN_GAP_SHARE`）。语料里
// 的判词是**写出它的那个版本**留下的：一条早于该门上线而记录的长窗，只带着旧判词。这里按今天的规则重算一遍，
// 结论是「今天的代码会怎么说」，**不是任何一次运行说过的话** —— 所以它单列一行、绝不并进上面那行的判词计数。
// 常量必须与生产者同一个数：自检会去读那个源文件，两边漂开就失败（没有那份文件的场景会具名跳过）。
const FROZEN_GAP_SHARE = 0.8
const STALL_CAUSE_SOURCE = join('src', 'main', 'diagnostics', 'stall-cause.ts')
// 自检要读生产者那份源文件：这里用脚本自己的位置推仓库根，别依赖调用时的工作目录。
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const FIXTURE_PREFIX = 'e2e'
const DEFAULT_TOP = 12
// 行上可能承载会话身份的字段。取第一个在场的：`sessionId` 是渲染侧与会话本身，`mainSessionId` 是
// reviewer 侧对主会话的称呼，`appSessionId` 是评审记录里对它的另一种称呼。
const SESSION_ID_FIELDS = ['sessionId', 'mainSessionId', 'appSessionId']
// 重复尝试看的是「同一个东西被撞了几次」，所以身份优先取**记录/运行级**的键：一次定稿认领（claimId）、
// 一个评审（reviewId）、一条产物运行（artifactRunId）都可能被反复尝试；会话 id 是最后的兜底。
const REPEAT_ID_FIELDS = [
  'claimId',
  'reviewId',
  'artifactRunId',
  'sessionId',
  'mainSessionId',
  'appSessionId'
]

export const PROVENANCE_FIXTURE = 'fixture'
export const PROVENANCE_REAL = 'real'
export const PROVENANCE_UNATTRIBUTED = 'unattributed'
export const PROVENANCE_MIXED = 'mixed'
const PROVENANCE_KEYS = [
  PROVENANCE_REAL,
  PROVENANCE_FIXTURE,
  PROVENANCE_MIXED,
  PROVENANCE_UNATTRIBUTED
]

const usage = () => {
  process.stderr.write(
    [
      'usage: node scripts/log-corpus-attribution.mjs [--log <file> ...] [--top <n>] [--json] [--recurrence] [--selftest]',
      '',
      'splits a log corpus by instance and by session provenance (real / fixture / unattributed) before',
      'summarising error and warning families, so a certification fixture cannot be counted as a defect.',
      '',
      '--recurrence also answers "was this failure already retried": rows are grouped by scope + message +',
      'one identity (claimId / reviewId / artifactRunId / sessionId), and only identities hit more than once',
      'are listed, with their row count, span and (when logged) the attempt range.',
      ''
    ].join('\n')
  )
}

const defaultLogDirs = () => {
  const root =
    process.platform === 'darwin' ? join(homedir(), 'Library', 'Logs') : join(homedir(), '.config')
  if (!existsSync(root)) return []
  const dirs = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (!entry.name.startsWith('PureScience')) continue
    // Linux 布局把日志再放一层 `logs/`；两种情况都认。
    dirs.push(join(root, entry.name))
    const nested = join(root, entry.name, 'logs')
    if (existsSync(nested)) dirs.push(nested)
  }
  return dirs
}

export const defaultLogFiles = () => {
  const files = []
  for (const dir of defaultLogDirs()) {
    for (const entry of readdirSync(dir)) {
      if (/^main(\.\d+)?\.log$/.test(entry)) files.push(join(dir, entry))
    }
  }
  // 轮转文件按名字排序会把 main.10 排到 main.2 前面；行内自带时间戳，排序只影响可读性。
  return files.sort()
}

/** 一行日志 → 一条记录，或 undefined（不是 JSON / 没有 msg 的行不是一条记录）。 */
export const parseLogLine = (line) => {
  if (!line.startsWith('{')) return undefined
  let record
  try {
    record = JSON.parse(line)
  } catch {
    return undefined
  }
  if (!record || typeof record !== 'object') return undefined
  const message = record.msg
  if (typeof message !== 'string' || message.length === 0) return undefined
  const level = typeof record.level === 'string' ? record.level : 'unknown'
  const data = record.data && typeof record.data === 'object' ? record.data : {}
  return {
    message,
    level,
    // `scope` 是顶层字段（不是 data 里的），重复尝试按「同一条失败的同一身份」聚合时需要它区分族。
    scope: typeof record.scope === 'string' ? record.scope : undefined,
    data,
    at: typeof record.t === 'string' ? record.t : undefined,
    runId: typeof record.runId === 'string' ? record.runId : undefined
  }
}

/**
 * 一行失败的「身份」：用于回答「同一个东西被撞了几次」。没有这类键时说 undefined——一条说不出身份
 * 的行不能与另一条说不出身份的行合成「重复」（那会把两个不同的事故读成一次重试）。
 */
export const identityOf = (data) => {
  for (const field of REPEAT_ID_FIELDS) {
    const value = data[field]
    if (typeof value === 'string' && value.length > 0) return { field, value }
  }
  return undefined
}

/**
 * 会话归属：`fixture` / `real` / `mixed` / `unattributed`。行上没有会话 id 时说 `unattributed`——把它读成
 * `real` 会让一条说不出出处的行冒充一条真实故障。
 */
export const provenanceOf = (data) => {
  const ids = sessionIdsOf(data)
  if (ids.length === 0) return PROVENANCE_UNATTRIBUTED
  return provenanceOfIds(ids)
}

/** 行自己带的会话 id（可能多个：主会话与评审记录各写一个字段）。 */
const sessionIdsOf = (data) => {
  const ids = []
  for (const field of SESSION_ID_FIELDS) {
    const value = data[field]
    if (typeof value === 'string' && value.length > 0) ids.push(value)
  }
  return ids
}

/**
 * 一组 id 的归属。两种都在场时说 `mixed`：那说明这一 run 横跨了夹具与真实会话，替它选边就是把一件
 * 说不清的事说成一件说得清的事。
 */
export const provenanceOfIds = (ids) => {
  if (ids.length === 0) return PROVENANCE_UNATTRIBUTED
  let fixture = 0
  for (const id of ids) if (id.toLowerCase().startsWith(FIXTURE_PREFIX)) fixture += 1
  if (fixture === ids.length) return PROVENANCE_FIXTURE
  if (fixture === 0) return PROVENANCE_REAL
  return PROVENANCE_MIXED
}

/**
 * 一行日志的归属。行上没有会话 id 时，借**同一个 run**（同一份文件里同一 `runId`）里出现过的 id：
 * 实测打包版与开发版的 `review protocol incomplete`（2,670 行）自己一个 id 都没有，而同一个 run 的
 * `reviewer session started` 写着 `e2e-session-*` —— 不借这一步，整族只能读成 `unattributed`，而它
 * 其实能判到夹具。借不到才是 `unattributed`。
 */
export const attributeRow = (entry, runIds) => {
  const own = sessionIdsOf(entry.data)
  if (own.length > 0) return provenanceOfIds(own)
  const runId = entry.runId
  if (typeof runId === 'string' && runId.length > 0) {
    const fromRun = runIds.get(runId)
    if (fromRun && fromRun.length > 0) return provenanceOfIds(fromRun)
  }
  return PROVENANCE_UNATTRIBUTED
}

const emptyCounts = () => ({
  [PROVENANCE_REAL]: 0,
  [PROVENANCE_FIXTURE]: 0,
  [PROVENANCE_MIXED]: 0,
  [PROVENANCE_UNATTRIBUTED]: 0
})

const bump = (counts, provenance, by = 1) => {
  counts[provenance] += by
}

export const analyse = (entries) => {
  // 第一遍：每个实例 × runId → 该 run 里出现过的会话 id。
  const runIndex = new Map()
  for (const entry of entries) {
    const instance = entry.instance ?? 'unknown'
    const runId = entry.runId
    if (typeof runId !== 'string' || runId.length === 0) continue
    const key = `${instance}\u0000${runId}`
    const ids = runIndex.get(key) ?? new Set()
    for (const id of sessionIdsOf(entry.data)) ids.add(id)
    runIndex.set(key, ids)
  }
  const runIdsFor = (instance) => {
    const map = new Map()
    for (const [key, ids] of runIndex) {
      const [owner, runId] = key.split('\u0000')
      if (owner === instance) map.set(runId, [...ids])
    }
    return map
  }

  const instances = new Map()
  const instanceOf = (entry) => entry.instance ?? 'unknown'
  for (const entry of entries) {
    const name = instanceOf(entry)
    const instance = instances.get(name) ?? {
      instance: name,
      rows: 0,
      levels: new Map(),
      errors: new Map(),
      warnings: new Map(),
      slowRows: 0,
      slowMs: 0,
      slowProvenance: emptyCounts(),
      // A slow row's wall time is not app work: `heldMs` is the part of it the loop was not running at all.
      // Kept apart for the same reason the three-way provenance is — summing both into one number is how
      // "the app spent an hour in its handlers" gets reported from a log that says the machine was asleep.
      // `noStall` is the producer's own way of saying "no loop-held window overlapped this call": it then
      // omits the fields, and the whole duration is the handler's. That is a different fact from a coverage
      // gap, so it gets its own counter and its own summed time.
      slowSplit: { splittable: 0, heldMs: 0, ownMs: 0, noStall: 0, noStallMs: 0, dropped: 0 },
      stalls: {
        rows: 0,
        causes: new Map(),
        frozenLateMs: 0,
        lateMsTotal: 0,
        // 「今天的门会怎么说」这一格：只由**记录下来的** sampler 读数决定，与写下的判词无关。
        // 读数缺席的行单独计数 —— 它们不可判，既不是 frozen 也不是 not-frozen。
        frozenMirror: { rows: 0, lateMs: 0, agree: 0, byShippedKind: new Map(), undecidable: 0 }
      },
      recurrence: new Map(),
      runIds: runIdsFor(name)
    }
    instances.set(name, instance)
    instance.rows += 1
    instance.levels.set(entry.level, (instance.levels.get(entry.level) ?? 0) + 1)
    const provenance = attributeRow(entry, instance.runIds)
    const family =
      entry.level === 'error'
        ? instance.errors
        : entry.level === 'warn'
          ? instance.warnings
          : undefined
    if (family) {
      const counts = family.get(entry.message) ?? emptyCounts()
      bump(counts, provenance)
      family.set(entry.message, counts)
    }
    if (entry.message === SLOW_IPC_MESSAGE) {
      instance.slowRows += 1
      const duration = entry.data.durationMs
      const durationMs = typeof duration === 'number' && Number.isFinite(duration) ? duration : 0
      instance.slowMs += durationMs
      bump(instance.slowProvenance, provenance)
      // `heldMs` is measured by the producer against the same windows the stall watchdog reports. Rows that
      // carry it are the only ones whose wall time can be split into "ours" and "the loop was not running";
      // A row with neither is counted under its own name rather than credited to either side.
      const held = entry.data.heldMs
      if (typeof held === 'number' && Number.isFinite(held)) {
        const own = entry.data.ownMs
        instance.slowSplit.splittable += 1
        instance.slowSplit.heldMs += Math.max(0, held)
        instance.slowSplit.ownMs +=
          typeof own === 'number' && Number.isFinite(own)
            ? Math.max(0, own)
            : Math.max(0, durationMs - held)
      } else if (entry.data.heldUnmeasured === 'windows-dropped') {
        instance.slowSplit.dropped += 1
      } else {
        instance.slowSplit.noStall += 1
        instance.slowSplit.noStallMs += durationMs
      }
    }
    // A stall row already carries its verdict; grouping by it keeps a corpus report from reading as
    // "the app froze 1,176 times" when most of those windows belonged to the machine.
    if (entry.message === STALL_MESSAGE) {
      instance.stalls.rows += 1
      const cause = entry.data.cause
      const kind = cause && typeof cause.kind === 'string' ? cause.kind : 'unstated'
      instance.stalls.causes.set(kind, (instance.stalls.causes.get(kind) ?? 0) + 1)
      const late = entry.data.lateMs
      if (typeof late === 'number' && Number.isFinite(late)) {
        instance.stalls.lateMsTotal += late
        if (kind === FROZEN_CAUSE) instance.stalls.frozenLateMs += late
      }
      // 同一道门的重算：`host` 是本进程自己 sampler 线程的读数，`maxGapMs` 是它错过的最宽一段。
      // 门要求「洞覆盖了 ≥FROZEN_GAP_SHARE 的窗口」；只在有读数时才能判，缺席的单独计数。
      const host = entry.data.host
      const maxGap =
        host && host.status === 'sampled' && typeof host.maxGapMs === 'number'
          ? host.maxGapMs
          : undefined
      if (typeof late === 'number' && Number.isFinite(late) && late > 0) {
        if (maxGap === undefined) {
          instance.stalls.frozenMirror.undecidable += 1
        } else if (maxGap >= late * FROZEN_GAP_SHARE) {
          instance.stalls.frozenMirror.rows += 1
          instance.stalls.frozenMirror.lateMs += late
          if (kind === FROZEN_CAUSE) instance.stalls.frozenMirror.agree += 1
          else
            instance.stalls.frozenMirror.byShippedKind.set(
              kind,
              (instance.stalls.frozenMirror.byShippedKind.get(kind) ?? 0) + 1
            )
        }
      }
    }
    // 重复尝试：只统计 error/warn，且必须有身份。`attempt` 只在部分族里出现（定稿认领有、修正注入没有），
    // 所以「撞了几次」以行数为准，`attempt` 的范围只作旁证（缺了就不写，不填 0）。
    if (entry.level === 'error' || entry.level === 'warn') {
      const identity = identityOf(entry.data)
      if (identity) {
        const key = `${entry.scope ?? ''}\u0000${entry.message}\u0000${identity.field}:${identity.value}`
        const repeat = instance.recurrence.get(key) ?? {
          scope: entry.scope,
          message: entry.message,
          identity,
          count: 0,
          firstAt: entry.at,
          lastAt: entry.at,
          attemptMin: undefined,
          attemptMax: undefined,
          ...emptyCounts()
        }
        repeat.count += 1
        bump(repeat, provenance)
        if (entry.at && (!repeat.firstAt || entry.at < repeat.firstAt)) repeat.firstAt = entry.at
        if (entry.at && (!repeat.lastAt || entry.at > repeat.lastAt)) repeat.lastAt = entry.at
        const attempt = entry.data.attempt
        if (typeof attempt === 'number' && Number.isInteger(attempt)) {
          repeat.attemptMin =
            repeat.attemptMin === undefined ? attempt : Math.min(repeat.attemptMin, attempt)
          repeat.attemptMax =
            repeat.attemptMax === undefined ? attempt : Math.max(repeat.attemptMax, attempt)
        }
        instance.recurrence.set(key, repeat)
      }
    }
  }
  const sortFamilies = (family) =>
    [...family.entries()]
      .map(([message, counts]) => {
        const total = PROVENANCE_KEYS.reduce((sum, key) => sum + counts[key], 0)
        return { message, total, ...counts }
      })
      .sort((a, b) => b.total - a.total)
  return [...instances.values()]
    .map((instance) => ({
      instance: instance.instance,
      rows: instance.rows,
      levels: Object.fromEntries([...instance.levels.entries()].sort((a, b) => b[1] - a[1])),
      errors: sortFamilies(instance.errors),
      warnings: sortFamilies(instance.warnings),
      slow: {
        rows: instance.slowRows,
        summedMs: Math.round(instance.slowMs),
        // Rounded once here so the printed line, the JSON and any reader's arithmetic agree.
        split: {
          splittable: instance.slowSplit.splittable,
          heldMs: Math.round(instance.slowSplit.heldMs),
          ownMs: Math.round(instance.slowSplit.ownMs),
          noStall: instance.slowSplit.noStall,
          noStallMs: Math.round(instance.slowSplit.noStallMs),
          dropped: instance.slowSplit.dropped
        },
        ...instance.slowProvenance
      },
      stalls: {
        rows: instance.stalls.rows,
        causes: [...instance.stalls.causes.entries()].sort((a, b) => b[1] - a[1]),
        lateMsTotal: Math.round(instance.stalls.lateMsTotal),
        frozenLateMs: Math.round(instance.stalls.frozenLateMs),
        // 重算（mirror）而不是判词：读的人要能看出这是今天的规则算出来的，并且有不可判的行。
        frozenMirror: {
          rows: instance.stalls.frozenMirror.rows,
          lateMs: Math.round(instance.stalls.frozenMirror.lateMs),
          agree: instance.stalls.frozenMirror.agree,
          byShippedKind: [...instance.stalls.frozenMirror.byShippedKind.entries()].sort(
            (a, b) => b[1] - a[1]
          ),
          undecidable: instance.stalls.frozenMirror.undecidable
        }
      },
      // 只留「重复」的：撞一次的身份不是重试问题，列出来会把表淹掉。
      repeats: [...instance.recurrence.values()]
        .filter((repeat) => repeat.count > 1)
        .sort((a, b) => b.count - a.count)
    }))
    .sort((a, b) => b.rows - a.rows)
}

const formatFamily = (family, top) => {
  const lines = []
  for (const entry of family.slice(0, top)) {
    const attributed = entry.fixture > 0 || entry.mixed > 0 || entry.unattributed > 0
    const tail = attributed
      ? `  (real ${entry.real} | fixture ${entry.fixture} | mixed ${entry.mixed} | unattributed ${entry.unattributed})`
      : ''
    lines.push(`    ${String(entry.total).padStart(5)}  ${entry.message}${tail}`)
  }
  if (family.length > top)
    lines.push(`    … ${family.length - top} more family/families not shown (--top)`)
  return lines
}

const formatRepeats = (repeats, top) => {
  if (repeats.length === 0) return ['  repeats: (none — no identity was hit twice)']
  const lines = ['  repeats (same identity, more than one row):']
  for (const repeat of repeats.slice(0, top)) {
    const attempts =
      repeat.attemptMin === undefined ? '' : `  attempt ${repeat.attemptMin}→${repeat.attemptMax}`
    const attributed =
      repeat.fixture > 0 || repeat.mixed > 0 || repeat.unattributed > 0
        ? `  (real ${repeat.real} | fixture ${repeat.fixture} | mixed ${repeat.mixed} | unattributed ${repeat.unattributed})`
        : ''
    lines.push(
      `    ${String(repeat.count).padStart(5)}  ${repeat.scope ?? '(no scope)'} | ${repeat.message} | ` +
        `${repeat.identity.field}=${repeat.identity.value}` +
        `${attempts}  ${repeat.firstAt ?? '?'} → ${repeat.lastAt ?? '?'}${attributed}`
    )
  }
  if (repeats.length > top)
    lines.push(`    … ${repeats.length - top} more repeated identity/identities (--top)`)
  return lines
}

export const formatReport = (report, top, options = {}) => {
  const lines = []
  lines.push(`log corpus attribution | instances=${report.length}`)
  for (const instance of report) {
    const levels = Object.entries(instance.levels)
      .map(([level, count]) => `${level}=${count}`)
      .join(' ')
    lines.push('')
    lines.push(`[${instance.instance}] rows=${instance.rows} ${levels}`)
    lines.push('  errors:')
    lines.push(
      ...(instance.errors.length > 0 ? formatFamily(instance.errors, top) : ['    (none)'])
    )
    lines.push('  warnings:')
    lines.push(
      ...(instance.warnings.length > 0 ? formatFamily(instance.warnings, top) : ['    (none)'])
    )
    lines.push(
      `  slow rows: ${instance.slow.rows} summed ${instance.slow.summedMs} ms  ` +
        `(real ${instance.slow.real} | fixture ${instance.slow.fixture} | mixed ${instance.slow.mixed} | ` +
        `unattributed ${instance.slow.unattributed})`
    )
    const split = instance.slow.split
    lines.push(
      split.splittable > 0
        ? `  slow split: ${split.splittable} row(s) split — own ${split.ownMs} ms | held (the loop was not ` +
            `running) ${split.heldMs} ms` +
            `; ${split.noStall} row(s) had no stall window over them (${split.noStallMs} ms, the whole ` +
            `duration is the handler's)${split.dropped > 0 ? ` | ring dropped ${split.dropped}` : ''}`
        : // Nothing measured is not "the loop was free": say which of the two this instance is.
          `  slow split: none of ${instance.slow.rows} row(s) carries a held/own split` +
            `${split.dropped > 0 ? ` (${split.dropped} lost their stall-window coverage)` : ''}`
    )
    if (instance.stalls.rows > 0) {
      const causes = instance.stalls.causes.map(([kind, count]) => `${kind} ${count}`).join(' | ')
      lines.push(
        `  stalls: ${instance.stalls.rows} late ${instance.stalls.lateMsTotal} ms — ${causes}` +
          (instance.stalls.frozenLateMs > 0
            ? `; ${instance.stalls.frozenLateMs} ms of it in windows where no thread of this process ran`
            : '')
      )
      const mirror = instance.stalls.frozenMirror
      const disagree = mirror.byShippedKind.map(([kind, count]) => `${kind} ${count}`).join(' | ')
      lines.push(
        `  frozen mirror: ${mirror.rows} of ${instance.stalls.rows} row(s) carry a sampler gap today's gate calls ` +
          `process-frozen (${mirror.lateMs} ms late) — ${mirror.agree} already say so` +
          (disagree ? `, ${mirror.rows - mirror.agree} disagree: ${disagree}` : '') +
          (mirror.undecidable > 0
            ? `; ${mirror.undecidable} row(s) carry no sampler reading and are undecidable, not "not frozen"`
            : '')
      )
      if (mirror.rows > 0)
        lines.push(
          '  (mirror = the rule in src/main/diagnostics/stall-cause.ts re-applied to the recorded sampler gap; ' +
            'it is not a verdict any run wrote)'
        )
    }
    if (options.recurrence) {
      lines.push(...formatRepeats(instance.repeats, top))
    }
  }
  lines.push('')
  lines.push(
    'read me: only `real` counts as a product defect. `fixture` rows come from the certification'
  )
  lines.push(
    'harness driving a stand-in agent, whose expected behaviour is not a product behaviour;'
  )
  lines.push(
    '`mixed` means one run carried both kinds of session id and neither side was picked for it;'
  )
  lines.push(
    '`unattributed` rows carry no session id and no run that does, so they belong to neither side.'
  )
  lines.push(
    'a slow row’s wall time is not app work: `slow split` says how much of it the loop was not running. `own` means'
  )
  lines.push(
    'only that the loop was running — a long turn legitimately has minutes of it, so read the row’s `cpuShare` before'
  )
  lines.push(
    'calling that time ours. A row with no held field had no stall window over it (its duration is the handler’s),'
  )
  lines.push(
    'which is not the same as a lost coverage ring. A stall row’s `cause.kind` names what held the loop;'
  )
  lines.push(
    '`process-frozen` means no thread of this process ran, so that window is the machine’s.'
  )
  lines.push(
    'The `frozen mirror` line applies that same gate to the sampler gap recorded on each row: it says what today’s'
  )
  lines.push(
    'code would call a window, not what the run that wrote the row said — a corpus produced before the gate shipped'
  )
  lines.push(
    'still carries the older label. A row with no sampler reading is undecidable, which is not “not frozen”.'
  )
  return lines.join('\n')
}

const parseArgs = (argv) => {
  const options = { logs: [], top: DEFAULT_TOP, json: false, recurrence: false, selftest: false }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--selftest') options.selftest = true
    else if (argument === '--json') options.json = true
    else if (argument === '--recurrence') options.recurrence = true
    else if (argument === '--log') {
      const value = argv[index + 1]
      if (!value) return undefined
      options.logs.push(value)
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

// 自检：钉住「三态归属」「同一族切开计数」「无 id 的行不许冒充 real」「空输入」四件事——这四件出错时
// 报表仍然好看，而那正是它会被信以为真的原因。
export const selftest = () => {
  const problems = []
  const line = (obj) => JSON.stringify(obj)
  const entries = [
    // r1：夹具 run —— 报错行自己没 id，借同一 run 的 `reviewer session started` 判到夹具
    parseLogLine(
      line({
        t: '2026-01-01T00:00:00Z',
        runId: 'r1',
        level: 'info',
        msg: 'reviewer session started',
        data: { sessionId: 'e2e-session-3' }
      })
    ),
    parseLogLine(
      line({
        t: '2026-01-01T00:00:00Z',
        runId: 'r1',
        level: 'error',
        msg: 'x failed',
        data: { reviewId: 'rv1' }
      })
    ),
    // 自己带真实 id 的行
    parseLogLine(
      line({
        t: '2026-01-01T00:00:01Z',
        level: 'error',
        msg: 'x failed',
        data: { sessionId: 'abc-123' }
      })
    ),
    // 既没 id 也没有可用 run 的行
    parseLogLine(
      line({ t: '2026-01-01T00:00:02Z', level: 'error', msg: 'x failed', data: { host: 'h' } })
    ),
    // 同一 run 里两种 id 都有 ⇒ mixed
    parseLogLine(
      line({
        t: '2026-01-01T00:00:02Z',
        runId: 'r2',
        level: 'info',
        msg: 'noise',
        data: { sessionId: 'e2e-session-9' }
      })
    ),
    parseLogLine(
      line({
        t: '2026-01-01T00:00:02Z',
        runId: 'r2',
        level: 'info',
        msg: 'noise',
        data: { mainSessionId: 'real-9' }
      })
    ),
    parseLogLine(
      line({ t: '2026-01-01T00:00:02Z', runId: 'r2', level: 'warn', msg: 'y warned', data: {} })
    ),
    parseLogLine(
      line({
        t: '2026-01-01T00:00:03Z',
        level: 'warn',
        msg: SLOW_IPC_MESSAGE,
        data: { channel: 'c', durationMs: 5 }
      })
    ),
    parseLogLine(line({ t: '2026-01-01T00:00:04Z', level: 'info', msg: 'noise', data: {} }))
  ].map((entry) => ({ ...entry, instance: 'PureScience' }))
  if (entries.some((entry) => entry === undefined)) problems.push('fixture lines must all parse')
  if (parseLogLine('not json') !== undefined) problems.push('a non-JSON line must not parse')
  if (parseLogLine(line({ msg: 'x' }))?.at !== undefined)
    problems.push('a line without a timestamp must parse without inventing one')

  const report = analyse(entries)
  const instance = report[0]
  if (!instance) problems.push('one instance expected')
  else {
    if (instance.rows !== 9) problems.push(`expected 9 rows, got ${instance.rows}`)
    const family = instance.errors.find((entry) => entry.message === 'x failed')
    if (!family) problems.push('the error family must be present')
    else {
      if (family.total !== 3) problems.push(`expected 3 error rows, got ${family.total}`)
      if (family.fixture !== 1)
        problems.push(`expected 1 fixture row (borrowed from its run), got ${family.fixture}`)
      if (family.real !== 1) problems.push(`expected 1 real row, got ${family.real}`)
      if (family.unattributed !== 1)
        problems.push(`an id-less row must be unattributed, got ${family.unattributed}`)
    }
    const mixed = instance.warnings.find((entry) => entry.message === 'y warned')
    if (!mixed || mixed.mixed !== 1)
      problems.push('a run carrying both id kinds must be mixed, not real or fixture')
    if (instance.slow.rows !== 1 || instance.slow.summedMs !== 5)
      problems.push(`slow rows must be counted: ${instance.slow.rows}/${instance.slow.summedMs}`)
    if (instance.slow.unattributed !== 1)
      problems.push('a slow row without a session id is unattributed')
  }
  if (provenanceOf({ sessionId: 'real-1' }) !== PROVENANCE_REAL)
    problems.push('a non-e2e id is real')
  if (provenanceOf({}) !== PROVENANCE_UNATTRIBUTED) problems.push('no id is unattributed, not real')
  if (provenanceOfIds(['e2e-1', 'real-1']) !== PROVENANCE_MIXED)
    problems.push('both id kinds in one set is mixed')
  if (analyse([]).length !== 0) problems.push('empty input must report no instances')
  // 重复尝试的自检：同一个 claimId 三行 ⇒ 一个 cluster 且 attempt 范围 1→3；另一个 claimId 只一行 ⇒ 不列出；
  // 没有身份的行既不能自成 cluster，也不能并进别的 cluster（那是把两件事读成一次重试）。
  const repeatEntries = [
    {
      t: '2026-01-01T00:00:00Z',
      level: 'error',
      scope: 'artifacts',
      msg: 'boom',
      data: { claimId: 'c1', attempt: 1 }
    },
    {
      t: '2026-01-01T00:01:00Z',
      level: 'error',
      scope: 'artifacts',
      msg: 'boom',
      data: { claimId: 'c1', attempt: 2 }
    },
    {
      t: '2026-01-01T00:02:00Z',
      level: 'error',
      scope: 'artifacts',
      msg: 'boom',
      data: { claimId: 'c1', attempt: 3 }
    },
    {
      t: '2026-01-01T00:03:00Z',
      level: 'error',
      scope: 'artifacts',
      msg: 'boom',
      data: { claimId: 'c2', attempt: 1 }
    },
    { t: '2026-01-01T00:04:00Z', level: 'error', scope: 'other', msg: 'boom', data: { host: 'h' } },
    { t: '2026-01-01T00:05:00Z', level: 'error', scope: 'other', msg: 'boom', data: { host: 'h' } }
  ].map((record) => ({ ...parseLogLine(JSON.stringify(record)), instance: 'PureScience' }))
  const repeatReport = analyse(repeatEntries)[0]
  if (repeatReport.repeats.length !== 1)
    problems.push(`expected exactly one repeated identity, got ${repeatReport.repeats.length}`)
  else {
    const repeat = repeatReport.repeats[0]
    if (repeat.count !== 3) problems.push(`expected 3 rows for claim c1, got ${repeat.count}`)
    if (repeat.identity.field !== 'claimId' || repeat.identity.value !== 'c1')
      problems.push(
        `expected identity claimId=c1, got ${repeat.identity.field}=${repeat.identity.value}`
      )
    if (repeat.attemptMin !== 1 || repeat.attemptMax !== 3)
      problems.push(`expected attempt range 1→3, got ${repeat.attemptMin}→${repeat.attemptMax}`)
    if (repeat.firstAt !== '2026-01-01T00:00:00Z' || repeat.lastAt !== '2026-01-01T00:02:00Z')
      problems.push(`expected the span of the c1 rows, got ${repeat.firstAt}→${repeat.lastAt}`)
  }
  if (identityOf({ host: 'h' }) !== undefined)
    problems.push('a row with no identity key must not claim one')
  // 慢行的时间归属：能切的切成「我们的 / 循环没在跑」，切不了的自成一态（不许并进任何一边），
  // 环丢掉的覆盖要有名字；停顿行按判词分组，整进程没在跑的窗口单独累计。
  const splitEntries = [
    // 切得开：held 与 own 都由生产者给出
    {
      level: 'warn',
      msg: SLOW_IPC_MESSAGE,
      data: { channel: 'a', durationMs: 1000, heldMs: 900, ownMs: 100 }
    },
    // 切得开但只给了 held：余量按 duration - held 推出
    { level: 'warn', msg: SLOW_IPC_MESSAGE, data: { channel: 'b', durationMs: 500, heldMs: 200 } },
    // 切不开：既没有 held 也没有具名缺口
    { level: 'warn', msg: SLOW_IPC_MESSAGE, data: { channel: 'c', durationMs: 70 } },
    // 切不开但是具名的：窗口环丢过覆盖
    {
      level: 'warn',
      msg: SLOW_IPC_MESSAGE,
      data: { channel: 'd', durationMs: 40, heldUnmeasured: 'windows-dropped' }
    },
    // 停顿：整进程没在跑的窗口与普通停顿各一行；sampler 读数在场的两行都可判
    {
      level: 'warn',
      msg: STALL_MESSAGE,
      data: {
        lateMs: 2000,
        cause: { kind: FROZEN_CAUSE },
        host: { status: 'sampled', maxGapMs: 1900 }
      }
    },
    {
      level: 'warn',
      msg: STALL_MESSAGE,
      data: {
        lateMs: 700,
        cause: { kind: 'unmeasured' },
        host: { status: 'sampled', maxGapMs: 100 }
      }
    },
    // 判词缺席的停顿行：不许被算成任何已知判词；也没有 sampler 读数 ⇒ 重算不可判（不是「没冻」）
    { level: 'warn', msg: STALL_MESSAGE, data: { lateMs: 300 } },
    // 重算：判词写的是 unmeasured，而 sampler 的洞盖住了窗口 ⇒ 今天的门会说 process-frozen
    {
      level: 'warn',
      msg: STALL_MESSAGE,
      data: {
        lateMs: 5000,
        cause: { kind: 'unmeasured' },
        host: { status: 'sampled', maxGapMs: 4500 }
      }
    },
    // 重算的另一半：sampler 根本没给读数（status 不是 sampled）⇒ 不可判，不许算成 not-frozen
    {
      level: 'warn',
      msg: STALL_MESSAGE,
      data: { lateMs: 5000, cause: { kind: 'unexplained' }, host: { status: 'unavailable' } }
    }
  ].map((record) => ({ ...parseLogLine(JSON.stringify(record)), instance: 'PureScience' }))
  const splitReport = analyse(splitEntries)[0]
  const split = splitReport.slow.split
  if (split.splittable !== 2) problems.push(`two rows carry a split, got ${split.splittable}`)
  if (split.heldMs !== 1100) problems.push(`held must sum to 1100, got ${split.heldMs}`)
  if (split.ownMs !== 400) problems.push(`own must be 100 + (500 - 200), got ${split.ownMs}`)
  if (split.noStall !== 1)
    problems.push(`a row with no stall window over it is noStall, got ${split.noStall}`)
  if (split.noStallMs !== 70)
    problems.push(`its duration still counts, expected 70, got ${split.noStallMs}`)
  if (split.dropped !== 1)
    problems.push(`a named coverage gap must be counted, got ${split.dropped}`)
  if (split.heldMs + split.ownMs > splitReport.slow.summedMs)
    problems.push('the split can never exceed the summed slow time')
  const stall = splitReport.stalls
  if (stall.rows !== 5) problems.push(`five stall rows expected, got ${stall.rows}`)
  if (stall.frozenLateMs !== 2000)
    problems.push(`frozen late ms must be 2000, got ${stall.frozenLateMs}`)
  if (stall.lateMsTotal !== 13000)
    problems.push(`late ms must total 13000, got ${stall.lateMsTotal}`)
  const frozenRow = stall.causes.find(([kind]) => kind === FROZEN_CAUSE)
  if (!frozenRow || frozenRow[1] !== 1)
    problems.push('the frozen window must be counted under its own verdict')
  const unstated = stall.causes.find(([kind]) => kind === 'unstated')
  if (!unstated || unstated[1] !== 1)
    problems.push('a stall row with no verdict is unstated, not a known cause')
  // 重算：只有「sampler 有读数且洞盖住 ≥80% 窗口」的行才算；写下的判词不参与这个判据，
  // 而缺席读数的行是**不可判**，不许并进 not-frozen。
  const mirror = stall.frozenMirror
  if (mirror.rows !== 2)
    problems.push(
      `mirror must call 2 rows frozen (the shipped-verdict one and the re-decided one), got ${mirror.rows}`
    )
  if (mirror.lateMs !== 7000) problems.push(`mirror late ms must be 7000, got ${mirror.lateMs}`)
  if (mirror.agree !== 1)
    problems.push(`exactly one mirror row already says frozen, got ${mirror.agree}`)
  const disagree = mirror.byShippedKind.find(([kind]) => kind === 'unmeasured')
  if (!disagree || disagree[1] !== 1)
    problems.push(
      `the re-decided row must be listed under its written verdict (unmeasured), got ${JSON.stringify(mirror.byShippedKind)}`
    )
  if (mirror.undecidable !== 2)
    problems.push(`two rows with no sampler reading must be undecidable, got ${mirror.undecidable}`)
  // 判据住在生产者里：这里重算用的是它的常量，两边漂开就等于用旧规则读新语料。
  const causeSource = join(REPO_ROOT, STALL_CAUSE_SOURCE)
  if (!existsSync(causeSource)) {
    process.stdout.write(
      `selftest note: ${STALL_CAUSE_SOURCE} is not on disk here, so the shared gate constant was not cross-checked\n`
    )
  } else {
    const declared = /FROZEN_GAP_SHARE\s*=\s*([0-9.]+)/.exec(readFileSync(causeSource, 'utf8'))
    if (!declared)
      problems.push(
        `${STALL_CAUSE_SOURCE} no longer declares FROZEN_GAP_SHARE — the mirror is stale`
      )
    else if (Number(declared[1]) !== FROZEN_GAP_SHARE)
      problems.push(
        `mirror gate ${FROZEN_GAP_SHARE} disagrees with ${STALL_CAUSE_SOURCE} (${declared[1]}) — update both`
      )
  }
  if (problems.length > 0) {
    process.stderr.write(`selftest FAILED:\n  ${problems.join('\n  ')}\n`)
    return 4
  }
  process.stdout.write(
    'selftest OK (run-borrowed provenance, three-way plus mixed, id-less rows are unattributed, repeated identity needs one, slow-row held split, stall verdicts, frozen-gate mirror + shared constant, empty input)\n'
  )
  return 0
}

const readEntries = (files) => {
  const entries = []
  const unreadable = []
  for (const file of files) {
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch (error) {
      unreadable.push({ file, reason: error instanceof Error ? error.message : String(error) })
      continue
    }
    const instance = basename(dirname(file))
    for (const line of text.split('\n')) {
      const entry = parseLogLine(line)
      if (entry) entries.push({ ...entry, instance })
    }
  }
  return { entries, unreadable }
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

  const { entries, unreadable } = readEntries(files)
  process.stderr.write(
    `files: ${files.map((file) => `${basename(dirname(file))}/${basename(file)}`).join(', ')}\n`
  )
  for (const entry of unreadable)
    process.stderr.write(`unreadable: ${entry.file} (${entry.reason})\n`)
  if (entries.length === 0) {
    process.stderr.write(
      'no-rows: the files carry no parsable log record (nothing here is a pass).\n'
    )
    return 3
  }

  const report = analyse(entries)
  process.stdout.write(
    options.json
      ? `${JSON.stringify(report, null, 2)}\n`
      : `${formatReport(report, options.top, { recurrence: options.recurrence })}\n`
  )
  return 0
}

if (process.argv[1] && process.argv[1].endsWith('log-corpus-attribution.mjs')) {
  process.exit(main())
}
