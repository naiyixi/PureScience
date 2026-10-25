// 中文别名检索评测（v2.18 §4）。可复跑，env-gated：真实网络请求，不进 CI。
//
//   PURESCIENCE_BENCH_ZH_ALIAS=1 npx vitest run scripts/bench/zh-alias-retrieval.bench.test.ts
//   → docs/bench-runs/<YYYY-MM-DD>-zh-alias-retrieval.jsonl / .md
//
// 它只量三件事，不做任何推断：
//   1. 改写覆盖率 —— 40 条中文术语里有多少条被 `planChineseQuery` 完整映射（`unmapped` 为空）、
//      多少条按命名拒绝（产品行为：拒绝而不是发一个只答了一半的查询）。
//   2. 命中率 —— 对映射后的英文查询，三个源各返回多少条；并抽样对照「直接发中文」的条数
//      （module header 里 2026-10-08 的 `阿司匹林 → 0` 就是这个形状，这里重新量一次而不是复述）。
//   3. 源间差异 —— 同一术语在 openalex / pubmed / arxiv 的条数与是否命中。
//
// 纪律：网络失败要写成该源该条的具名失败（`error: '...'`），不写 0，也不跳过。
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { planChineseQuery } from '../../src/shared/chinese-terms'

type SourceName = 'pubmed' | 'openalex' | 'arxiv'

type Reading = {
  term: string
  kind: 'gene' | 'protein' | 'disease' | 'compound'
  applied: string[]
  query: string
  unmapped: string[]
  outcome: 'rewritten' | 'refused'
  sources: Record<SourceName, { count: number | null; error?: string }>
  /** 抽样对照：直接发中文时的条数（只在 SAMPLE_CONTROL 里的术语上测）。 */
  rawChinese?: Record<SourceName, { count: number | null; error?: string }>
}

const GLOSSARY: Array<{ term: string; kind: Reading['kind'] }> = [
  // 基因
  { term: 'TP53', kind: 'gene' },
  { term: 'BRCA1', kind: 'gene' },
  { term: 'EGFR', kind: 'gene' },
  { term: 'KRAS', kind: 'gene' },
  { term: 'APOE', kind: 'gene' },
  { term: 'MYC', kind: 'gene' },
  { term: 'PTEN', kind: 'gene' },
  { term: 'CFTR', kind: 'gene' },
  { term: 'HBB', kind: 'gene' },
  { term: 'MTHFR', kind: 'gene' },
  // 蛋白
  { term: 'p53 蛋白', kind: 'protein' },
  { term: '血管内皮生长因子', kind: 'protein' },
  { term: '肿瘤坏死因子', kind: 'protein' },
  { term: '白细胞介素6', kind: 'protein' },
  { term: 'C反应蛋白', kind: 'protein' },
  { term: '淀粉样蛋白', kind: 'protein' },
  { term: '胰岛素', kind: 'protein' },
  { term: '血红蛋白', kind: 'protein' },
  { term: '肌钙蛋白', kind: 'protein' },
  { term: '降钙素原', kind: 'protein' },
  // 疾病
  { term: '肺癌', kind: 'disease' },
  { term: '乳腺癌', kind: 'disease' },
  { term: '结直肠癌', kind: 'disease' },
  { term: '肝细胞癌', kind: 'disease' },
  { term: '2型糖尿病', kind: 'disease' },
  { term: '高血压', kind: 'disease' },
  { term: '脑卒中', kind: 'disease' },
  { term: '阿尔茨海默病', kind: 'disease' },
  { term: '帕金森病', kind: 'disease' },
  { term: '慢性阻塞性肺疾病', kind: 'disease' },
  // 化合物 / 药物
  { term: '阿司匹林', kind: 'compound' },
  { term: '二甲双胍', kind: 'compound' },
  { term: '他汀', kind: 'compound' },
  { term: '华法林', kind: 'compound' },
  { term: '氯吡格雷', kind: 'compound' },
  { term: '紫杉醇', kind: 'compound' },
  { term: '顺铂', kind: 'compound' },
  { term: '曲妥珠单抗', kind: 'compound' },
  { term: '纳武利尤单抗', kind: 'compound' },
  { term: '瑞舒伐他汀', kind: 'compound' }
]

// 直接发中文的对照只做样本：module header 已量过一次 0 命中，这里重新量而不是复述。
const SAMPLE_CONTROL = new Set(['阿司匹林', '肺癌', '二甲双胍', 'TP53', '脑卒中'])

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const countPubmed = async (query: string): Promise<number> => {
  const url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&retmode=json&term=${encodeURIComponent(query)}`
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) })
  if (!response.ok) throw new Error(`pubmed http ${response.status}`)
  const body = (await response.json()) as { esearchresult?: { count?: string } }
  const count = Number(body.esearchresult?.count)
  if (!Number.isFinite(count)) throw new Error('pubmed returned no count')
  return count
}

const countOpenalex = async (query: string): Promise<number> => {
  const url = `https://api.openalex.org/works?per-page=1&search=${encodeURIComponent(query)}`
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) })
  if (!response.ok) throw new Error(`openalex http ${response.status}`)
  const body = (await response.json()) as { meta?: { count?: number } }
  const count = body.meta?.count
  if (typeof count !== 'number') throw new Error('openalex returned no count')
  return count
}

const countArxiv = async (query: string): Promise<number> => {
  const url = `https://export.arxiv.org/api/query?max_results=1&search_query=${encodeURIComponent(`all:${query}`)}`
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) })
  if (!response.ok) throw new Error(`arxiv http ${response.status}`)
  const text = await response.text()
  const match = /<opensearch:totalResults[^>]*>(\d+)</u.exec(text)
  if (!match?.[1]) throw new Error('arxiv returned no totalResults')
  return Number(match[1])
}

const measure = async (
  query: string
): Promise<Record<SourceName, { count: number | null; error?: string }>> => {
  const reading: Record<SourceName, { count: number | null; error?: string }> = {
    pubmed: { count: null },
    openalex: { count: null },
    arxiv: { count: null }
  }
  for (const [name, run] of [
    ['pubmed', countPubmed],
    ['openalex', countOpenalex],
    ['arxiv', countArxiv]
  ] as const) {
    try {
      reading[name] = { count: await run(query) }
    } catch (error) {
      reading[name] = {
        count: null,
        error: error instanceof Error ? error.message : String(error)
      }
    }
    // arXiv asks for ~3 s between requests; the other two are fine at this pace.
    await sleep(name === 'arxiv' ? 3_000 : 350)
  }
  return reading
}

const percent = (value: number, total: number): string =>
  total === 0 ? '—' : `${((value / total) * 100).toFixed(1)}%`

describe.skipIf(process.env.PURESCIENCE_BENCH_ZH_ALIAS !== '1')('中文别名检索评测', () => {
  it(
    '把 40 条中文术语的改写覆盖率与三源命中率量出来并落盘',
    async () => {
      const readings: Reading[] = []
      for (const { term, kind } of GLOSSARY) {
        const plan = planChineseQuery(term)
        const outcome: Reading['outcome'] = plan.unmapped.length === 0 ? 'rewritten' : 'refused'
        const sources = outcome === 'rewritten' ? await measure(plan.query) : await measure(term)
        const reading: Reading = {
          term,
          kind,
          applied: plan.applied.map((entry) => `${entry.from}→${entry.to}`),
          query: plan.query,
          unmapped: [...plan.unmapped],
          outcome,
          sources
        }
        if (SAMPLE_CONTROL.has(term)) reading.rawChinese = await measure(term)
        readings.push(reading)
        process.stdout.write(
          `${outcome === 'rewritten' ? '改写' : '拒绝'} ${term} → ${plan.query} | ` +
            `pubmed=${sources.pubmed.count ?? sources.pubmed.error} ` +
            `openalex=${sources.openalex.count ?? sources.openalex.error} ` +
            `arxiv=${sources.arxiv.count ?? sources.arxiv.error}\n`
        )
      }

      const rewritten = readings.filter((reading) => reading.outcome === 'rewritten')
      const control = readings.filter((reading) => reading.rawChinese)
      const rowsBySource = (name: SourceName, list: Reading[]): string =>
        list
          .map((reading) => {
            const cell = reading.sources[name]
            return cell.count === null ? (cell.error ?? 'error') : String(cell.count)
          })
          .join(' / ')

      const summary = [
        '# 中文别名检索评测（v2.18 §4）',
        '',
        `- 术语表：**${readings.length}** 条（基因 ${readings.filter((r) => r.kind === 'gene').length} / 蛋白 ${readings.filter((r) => r.kind === 'protein').length} / 疾病 ${readings.filter((r) => r.kind === 'disease').length} / 化合物 ${readings.filter((r) => r.kind === 'compound').length}）`,
        `- 被完整改写（unmapped 为空）：**${rewritten.length}** 条（${percent(rewritten.length, readings.length)}）`,
        `- 按命名拒绝：**${readings.length - rewritten.length}** 条`,
        '',
        '## 改写覆盖率（指标 2）',
        '',
        '| 术语 | 类型 | 结果 | 发送的查询 | 未映射残留 |',
        '|---|---|---|---|---|',
        ...readings.map(
          (reading) =>
            `| ${reading.term} | ${reading.kind} | ${reading.outcome === 'rewritten' ? '改写' : '**拒绝**'} | \`${reading.query}\` | ${reading.unmapped.join('、') || '—'} |`
        ),
        '',
        '## 三源命中条数（指标 1、3）',
        '',
        '| 术语 | pubmed | openalex | arxiv |',
        '|---|---|---|---|',
        ...readings.map(
          (reading) =>
            `| ${reading.term} | ${reading.sources.pubmed.count ?? reading.sources.pubmed.error ?? '—'} | ${reading.sources.openalex.count ?? reading.sources.openalex.error ?? '—'} | ${reading.sources.arxiv.count ?? reading.sources.arxiv.error ?? '—'} |`
        ),
        '',
        '## 直接发中文的对照（抽样）',
        '',
        '| 术语 | 源 | 英文查询条数 | 直接发中文条数 |',
        '|---|---|---|---|',
        ...control.flatMap((reading) =>
          (['pubmed', 'openalex', 'arxiv'] as SourceName[]).map(
            (name) =>
              `| ${reading.term} | ${name} | ${reading.sources[name].count ?? '—'} | ${reading.rawChinese?.[name].count ?? reading.rawChinese?.[name].error ?? '—'} |`
          )
        ),
        '',
        '## 口径',
        '',
        '- 条数是各源自己报的命中总数（PubMed `esearchresult.count`、OpenAlex `meta.count`、arXiv `opensearch:totalResults`），不是我们的排序结果。',
        '- 网络失败记成该源该条的具名错误，不记 0、不跳过。',
        '- 被拒绝的术语仍然发出去量了（为了对照），但产品实际行为是**拒绝并点名**，不发半截查询。',
        `- pubmed 行：\`${rowsBySource('pubmed', readings).slice(0, 60)}…\``,
        ''
      ].join('\n')

      const stamp = new Date().toISOString().slice(0, 10)
      const dir = join(process.cwd(), 'docs', 'bench-runs')
      await mkdir(dir, { recursive: true })
      await writeFile(
        join(dir, `${stamp}-zh-alias-retrieval.jsonl`),
        `${readings.map((reading) => JSON.stringify(reading)).join('\n')}\n`,
        'utf8'
      )
      await writeFile(join(dir, `${stamp}-zh-alias-retrieval.md`), summary, 'utf8')

      // 仪器自检：不是对命中率的断言，而是「这次真的量到了东西」。
      expect(readings).toHaveLength(GLOSSARY.length)
      const anyCounted = readings.some((reading) =>
        (['pubmed', 'openalex', 'arxiv'] as SourceName[]).some(
          (name) => typeof reading.sources[name].count === 'number'
        )
      )
      expect(anyCounted).toBe(true)
      process.stdout.write(`\n落盘：docs/bench-runs/${stamp}-zh-alias-retrieval.{jsonl,md}\n`)
    },
    15 * 60_000
  )
})
