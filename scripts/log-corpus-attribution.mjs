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

const SLOW_IPC_MESSAGE = 'ipc handler was slow'
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
      instance.slowMs += typeof duration === 'number' && Number.isFinite(duration) ? duration : 0
      bump(instance.slowProvenance, provenance)
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
        ...instance.slowProvenance
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
  if (problems.length > 0) {
    process.stderr.write(`selftest FAILED:\n  ${problems.join('\n  ')}\n`)
    return 4
  }
  process.stdout.write(
    'selftest OK (run-borrowed provenance, three-way plus mixed, id-less rows are unattributed, repeated identity needs one, empty input)\n'
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
