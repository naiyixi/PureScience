// 从**已经存在的**会话语料里算 token × 墙钟成本矩阵（v2.18 §2）。
//
// 为什么不需要再跑模型：每一轮的 provider usage 早就落盘了（`AcpTurnTokenUsage` 在每条 agent 消息的
// `turnUsage` 上，来源只有 provider 响应）。所以这一步是**只读聚合**，不是重新采样。
//
//   PURESCIENCE_BENCH_COST_MATRIX=1 npx vitest run scripts/bench/cost-matrix-from-sessions.bench.test.ts
//   → docs/bench-runs/<YYYY-MM-DD>-cost-matrix.{jsonl,md}
//
// 纪律（v2.18 §2 原文）：
//   * 只有 `source: 'provider'` 的行进 token 列 —— 这里只读 `turnUsage`，它是 provider 的来源，估算值走的是
//     `contextUsage`，两者不混；
//   * 单价没接进产品之前**不出现任何金额**；
//   * 墙钟只在消息同时带 `createdAt` 与 `completedAt` 时计入，否则该轮只算 token（不猜）。
//
// 只读保证：直接读 JSON 文件 + 用应用自己的 `normalizeSessionFile` 归一化，⚠️ 不调用任何会写索引/做修复的
// 仓储方法（`loadAllWithDiagnostics` 会在真语料上判 corrupt 并改名，见技能里的坑）。
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { normalizeSessionFile } from '../../src/shared/session-persistence'

type MatrixRow = {
  framework: string
  model: string
  turns: number
  promptTokens: number
  cacheTokens: number
  completionTokens: number
  /** 只用 provider 记账的行；`turnUsage` 是唯一来源，所以这一列恒等于 turns。 */
  providerTurns: number
  wallClockMs: number
  /** 墙钟只覆盖这么多轮（其余缺 completedAt）。 */
  timedTurns: number
  /** 每轮墙钟的中位数与 p90：合计时长掩盖了「一轮很慢」，而慢的是体感。 */
  turnMsP50: number
  turnMsP90: number
}

const SKIP = /(summary|\.invalid-|catalog)/u

const listSessionFiles = async (root: string): Promise<string[]> => {
  const files: string[] = []
  for (const project of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!project.isDirectory()) continue
    const dir = join(root, project.name)
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isFile() || !entry.name.endsWith('.json') || SKIP.test(entry.name)) continue
      files.push(join(dir, entry.name))
    }
  }
  return files
}

type Aggregate = Map<string, MatrixRow>

const addRow = (
  aggregate: Aggregate,
  key: { framework: string; model: string },
  usage: { inputTokens: number; cacheTokens: number; outputTokens: number },
  wallClockMs: number | undefined
): void => {
  const id = `${key.framework}\u0000${key.model}`
  const row =
    aggregate.get(id) ??
    ({
      framework: key.framework,
      model: key.model,
      turns: 0,
      promptTokens: 0,
      cacheTokens: 0,
      completionTokens: 0,
      providerTurns: 0,
      wallClockMs: 0,
      timedTurns: 0,
      turnMsP50: 0,
      turnMsP90: 0
    } satisfies MatrixRow)
  row.turns += 1
  row.providerTurns += 1
  row.promptTokens += usage.inputTokens
  row.cacheTokens += usage.cacheTokens
  row.completionTokens += usage.outputTokens
  if (wallClockMs !== undefined && wallClockMs >= 0) {
    row.wallClockMs += wallClockMs
    row.timedTurns += 1
  }
  aggregate.set(id, row)
}

describe.skipIf(process.env.PURESCIENCE_BENCH_COST_MATRIX !== '1')('会话语料的成本矩阵', () => {
  it(
    '只读聚合真实会话里的 provider usage 与墙钟',
    async () => {
      const root =
        process.env.PURESCIENCE_BENCH_SESSIONS_ROOT ?? join(homedir(), '.purescience', 'sessions')
      const files = await listSessionFiles(root)
      expect(files.length, '没有找到会话文件：先确认 sessions 根').toBeGreaterThan(0)

      const aggregate: Aggregate = new Map()
      const turnSamples = new Map<string, number[]>()
      let scanned = 0
      let withUsage = 0
      for (const file of files) {
        let parsed: unknown
        try {
          parsed = JSON.parse(await readFile(file, 'utf8')) as unknown
        } catch {
          continue
        }
        const session = normalizeSessionFile(parsed)
        if (!session) continue
        scanned += 1
        const framework = session.agentFrameworkId ?? 'unknown'
        const model = session.agentModel ?? 'unknown'
        for (const message of session.messages ?? []) {
          const usage = message.turnUsage
          if (!usage) continue
          withUsage += 1
          const wallClockMs =
            typeof message.completedAt === 'number' && typeof message.createdAt === 'number'
              ? message.completedAt - message.createdAt
              : undefined
          addRow(
            aggregate,
            { framework, model },
            {
              inputTokens: usage.inputTokens,
              cacheTokens: usage.cacheTokens,
              outputTokens: usage.outputTokens
            },
            wallClockMs
          )
          if (wallClockMs !== undefined && wallClockMs >= 0) {
            const key = `${framework}\u0000${model}`
            const samples = turnSamples.get(key) ?? []
            samples.push(wallClockMs)
            turnSamples.set(key, samples)
          }
        }
      }

      const percentile = (samples: readonly number[], fraction: number): number => {
        if (samples.length === 0) return 0
        const sorted = [...samples].sort((left, right) => left - right)
        const index = Math.min(sorted.length - 1, Math.floor(fraction * (sorted.length - 1)))
        return sorted[index] ?? 0
      }
      const rows = [...aggregate.values()]
        .map((row) => {
          const samples = turnSamples.get(`${row.framework}\u0000${row.model}`) ?? []
          return {
            ...row,
            turnMsP50: percentile(samples, 0.5),
            turnMsP90: percentile(samples, 0.9)
          }
        })
        .sort((left, right) => right.promptTokens - left.promptTokens)
      const lines = [
        '# 成本矩阵：token × 墙钟（来自已有会话语料）',
        '',
        `- 扫描会话：**${scanned}** 个（共 ${files.length} 个文件）`,
        `- 含 provider usage 的轮次：**${withUsage}**`,
        `- 分组：**${rows.length}**（framework × model）`,
        '- **本表不含金额**：计费单价与折扣没有接进产品，写美元就是把猜测当读数。',
        '- token 列只来自 `turnUsage`（provider 响应）；估算值在 `contextUsage`，两者不混。',
        '',
        '| framework | model | 轮次 | prompt | cache | completion | 墙钟(ms) | p50/轮 | p90/轮 | 计墙钟轮次 |',
        '|---|---|---|---|---|---|---|---|---|---|',
        ...rows.map(
          (row) =>
            `| ${row.framework} | ${row.model} | ${row.turns} | ${row.promptTokens} | ${row.cacheTokens} | ${row.completionTokens} | ${row.wallClockMs} | ${row.turnMsP50} | ${row.turnMsP90} | ${row.timedTurns} |`
        ),
        '',
        '## 口径',
        '',
        '- 墙钟只统计同时带 `createdAt` 与 `completedAt` 的轮次；缺一个就只算 token，不猜耗时。',
        '- `turnUsage` 是**每轮聚合**（一轮内可能含多次模型请求，见消息上的 `turnCount`），不是累计值；' +
          '缓存读取之所以比 prompt 大两个量级，是因为同一轮里每次内层请求都会重读一次缓存前缀 —— ' +
          '这是 provider 真实计费的口径，不是重复计数。',
        '- `p50/轮` 与 `p90/轮` 只覆盖「带墙钟」的轮次；**0 是真的 0**（该轮 `completedAt` 与 `createdAt` 相同），' +
          '不是缺数据 —— 缺数据的轮次根本不计入 `计墙钟轮次`。',
        '- 只读保证：直接读 JSON 并用应用自己的 `normalizeSessionFile` 归一化，不调用任何会写索引或做修复的仓储方法。',
        ...(rows[0]
          ? [
              '',
              `最大一组（${rows[0].framework} / ${rows[0].model}）的 cache/prompt = **${(
                rows[0].cacheTokens / Math.max(1, rows[0].promptTokens)
              ).toFixed(1)}×** —— 只看 prompt 会严重低估上下文成本。`
            ]
          : []),
        ''
      ]

      const stamp = new Date().toISOString().slice(0, 10)
      const dir = join(process.cwd(), 'docs', 'bench-runs')
      await mkdir(dir, { recursive: true })
      await writeFile(
        join(dir, `${stamp}-cost-matrix.jsonl`),
        `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`,
        'utf8'
      )
      await writeFile(join(dir, `${stamp}-cost-matrix.md`), lines.join('\n'), 'utf8')

      process.stdout.write(
        `\n矩阵：${rows.length} 组，${withUsage} 轮\n落盘：docs/bench-runs/${stamp}-cost-matrix.{jsonl,md}\n`
      )
      // 仪器自检：空读数不能当成矩阵交出去。
      expect(rows.length).toBeGreaterThan(0)
      expect(withUsage).toBeGreaterThan(0)
    },
    10 * 60_000
  )
})
