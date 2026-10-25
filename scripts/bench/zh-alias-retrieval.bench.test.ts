// 中文别名检索评测（v2.18 §4）。可复跑，env-gated：真实网络请求，不进 CI。
//
//   PURESCIENCE_BENCH_ZH_ALIAS=1 npx vitest run scripts/bench/zh-alias-retrieval.bench.test.ts
//   → docs/bench-runs/<YYYY-MM-DD>-zh-alias-retrieval.jsonl / .md
//
// 三个指标（§4 原文），每个都只读该源自己返回的东西：
//   1. top-k 命中率 —— 改写后的英文查询，该源 top-5 标题里是否真的出现这个术语（不是「总条数 > 0」那种弱口径）；
//   2. 改写覆盖率 —— 40 条中文术语里有多少条被 planChineseQuery 完整映射、多少条按名拒绝；
//   3. 源间差异 —— 同一术语在三个源上的命中矩阵，以及「只有一个源命中」的条数。跨源比排名没有意义
//      （三套语料不同），所以只比命中/未命中，不臆造排名相关性。
//
// 纪律：网络失败记成该源该条的具名错误，不写 0、不跳过；「没命中」与「0 条结果」是两个数，分开记。
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { planChineseQuery } from '../../src/shared/chinese-terms'

type SourceName = 'pubmed' | 'openalex' | 'arxiv'

type SourceReading = {
  /** 该源自报的命中总数；null = 读不到。 */
  total: number | null
  /** top-5 标题（原样，截断到 160 字符）。 */
  top: string[]
  /** top-5 里是否出现该术语。 */
  hit: boolean
  error?: string
}

type Reading = {
  term: string
  kind: 'gene' | 'protein' | 'disease' | 'compound'
  applied: string[]
  query: string
  unmapped: string[]
  outcome: 'rewritten' | 'refused'
  sources: Record<SourceName, SourceReading>
  rawChinese?: Record<SourceName, SourceReading>
}

const GLOSSARY: Array<{ term: string; kind: Reading['kind'] }> = [
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

// 直接发中文的对照只做样本：module header 里 2026-10-08 的 0 命中要重新量一次，而不是复述。
const SAMPLE_CONTROL = new Set(['阿司匹林', '肺癌', '二甲双胍', 'TP53', '脑卒中'])

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')

/** 术语是否出现在标题里：整词/短语、大小写不敏感。 */
const titleMentions = (titles: readonly string[], term: string): boolean => {
  const needle = term.trim().toLowerCase()
  if (needle.length === 0) return false
  const pattern = new RegExp(`(^|[^a-z0-9])${escapeRegExp(needle)}([^a-z0-9]|$)`, 'iu')
  return titles.some((title) => pattern.test(title.toLowerCase()))
}

const trim = (title: string): string => title.replace(/\s+/gu, ' ').trim().slice(0, 160)

const readPubmed = async (query: string): Promise<SourceReading> => {
  const base = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils'
  const search = await fetch(
    `${base}/esearch.fcgi?db=pubmed&retmode=json&retmax=5&term=${encodeURIComponent(query)}`,
    { signal: AbortSignal.timeout(20_000) }
  )
  if (!search.ok) throw new Error(`pubmed search http ${search.status}`)
  const body = (await search.json()) as { esearchresult?: { count?: string; idlist?: string[] } }
  const total = Number(body.esearchresult?.count)
  const ids = body.esearchresult?.idlist ?? []
  if (!Number.isFinite(total)) throw new Error('pubmed returned no count')
  let top: string[] = []
  if (ids.length > 0) {
    const summary = await fetch(
      `${base}/esummary.fcgi?db=pubmed&retmode=json&id=${ids.join(',')}`,
      {
        signal: AbortSignal.timeout(20_000)
      }
    )
    if (summary.ok) {
      const detail = (await summary.json()) as {
        result?: Record<string, { title?: string }> & { uids?: string[] }
      }
      top = (detail.result?.uids ?? [])
        .map((uid) => trim(detail.result?.[uid]?.title ?? ''))
        .filter((title) => title.length > 0)
        .slice(0, 5)
    }
  }
  return { total, top, hit: titleMentions(top, query) }
}

const readOpenalex = async (query: string): Promise<SourceReading> => {
  const response = await fetch(
    `https://api.openalex.org/works?per-page=5&search=${encodeURIComponent(query)}`,
    { signal: AbortSignal.timeout(20_000) }
  )
  if (!response.ok) throw new Error(`openalex http ${response.status}`)
  const body = (await response.json()) as {
    meta?: { count?: number }
    results?: Array<{ title?: string; display_name?: string }>
  }
  const total = body.meta?.count ?? null
  const top = (body.results ?? [])
    .map((work) => trim(work.title ?? work.display_name ?? ''))
    .filter((title) => title.length > 0)
    .slice(0, 5)
  return { total, top, hit: titleMentions(top, query) }
}

const readArxiv = async (query: string): Promise<SourceReading> => {
  const response = await fetch(
    `https://export.arxiv.org/api/query?max_results=5&search_query=${encodeURIComponent(`all:${query}`)}`,
    { signal: AbortSignal.timeout(20_000) }
  )
  if (!response.ok) throw new Error(`arxiv http ${response.status}`)
  const text = await response.text()
  const totalMatch = /<opensearch:totalResults[^>]*>(\d+)</u.exec(text)
  const top = [...text.matchAll(/<entry>[\s\S]*?<title>([\s\S]*?)<\/title>/gu)]
    .map((match) => trim(match[1] ?? ''))
    .filter((title) => title.length > 0)
    .slice(0, 5)
  return {
    total: totalMatch?.[1] ? Number(totalMatch[1]) : null,
    top,
    hit: titleMentions(top, query)
  }
}

const READERS: Array<[SourceName, (query: string) => Promise<SourceReading>]> = [
  ['pubmed', readPubmed],
  ['openalex', readOpenalex],
  ['arxiv', readArxiv]
]

const emptySource = (): SourceReading => ({ total: null, top: [], hit: false })

const emptyReading = (): Record<SourceName, SourceReading> => ({
  pubmed: emptySource(),
  openalex: emptySource(),
  arxiv: emptySource()
})

const measure = async (query: string): Promise<Record<SourceName, SourceReading>> => {
  const reading = emptyReading()
  for (const [name, read] of READERS) {
    try {
      reading[name] = await read(query)
    } catch (error) {
      reading[name] = {
        ...emptySource(),
        error: error instanceof Error ? error.message : String(error)
      }
    }
    // arXiv 要求约 3 秒一次；另外两个按这个节奏也没问题。
    await sleep(name === 'arxiv' ? 3_000 : 350)
  }
  return reading
}

const percent = (value: number, total: number): string =>
  total === 0 ? '—' : `${((value / total) * 100).toFixed(1)}%`

const cell = (reading: SourceReading): string =>
  reading.error ? `err` : reading.hit ? '命中' : '未命中'

describe.skipIf(process.env.PURESCIENCE_BENCH_ZH_ALIAS !== '1')('中文别名检索评测', () => {
  it(
    '量 top-5 命中、改写覆盖率与源间差异并落盘',
    async () => {
      const readings: Reading[] = []
      for (const { term, kind } of GLOSSARY) {
        const plan = planChineseQuery(term)
        const outcome: Reading['outcome'] = plan.unmapped.length === 0 ? 'rewritten' : 'refused'
        const sources = await measure(outcome === 'rewritten' ? plan.query : term)
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
            READERS.map(
              ([name]) =>
                `${name}=${cell(sources[name])}${
                  sources[name].total === null ? '' : `(${sources[name].total})`
                }`
            ).join(' ') +
            '\n'
        )
      }

      const rewritten = readings.filter((reading) => reading.outcome === 'rewritten')
      const sourceNames = READERS.map(([name]) => name)
      const hitCounts = Object.fromEntries(
        sourceNames.map((name) => [
          name,
          readings.filter((reading) => reading.sources[name].hit).length
        ])
      ) as Record<SourceName, number>
      const onlyOne = readings.filter(
        (reading) => sourceNames.filter((name) => reading.sources[name].hit).length === 1
      )
      const control = readings.filter((reading) => reading.rawChinese)

      const summary = [
        '# 中文别名检索评测（v2.18 §4）',
        '',
        `- 术语表：**${readings.length}** 条（基因 ${readings.filter((r) => r.kind === 'gene').length} / 蛋白 ${readings.filter((r) => r.kind === 'protein').length} / 疾病 ${readings.filter((r) => r.kind === 'disease').length} / 化合物 ${readings.filter((r) => r.kind === 'compound').length}）`,
        `- 被完整改写（unmapped 为空）：**${rewritten.length}** 条（${percent(rewritten.length, readings.length)}）；按名拒绝 ${readings.length - rewritten.length} 条`,
        '',
        '## 指标 1：top-5 命中率（判据是「标题里真的出现该术语」，不是总条数 > 0）',
        '',
        '| 源 | top-5 命中 | 命中率 |',
        '|---|---|---|',
        ...sourceNames.map(
          (name) =>
            `| ${name} | ${hitCounts[name]}/${readings.length} | ${percent(hitCounts[name], readings.length)} |`
        ),
        '',
        '## 指标 2：改写覆盖率',
        '',
        '| 术语 | 类型 | 结果 | 发送的查询 | 未映射残留 |',
        '|---|---|---|---|---|',
        ...readings.map(
          (reading) =>
            `| ${reading.term} | ${reading.kind} | ${reading.outcome === 'rewritten' ? '改写' : '**拒绝**'} | \`${reading.query}\` | ${reading.unmapped.join('、') || '—'} |`
        ),
        '',
        '## 指标 3：源间命中矩阵（只比命中/未命中，不跨源比排名——三套语料不同）',
        '',
        '| 术语 | pubmed | openalex | arxiv |',
        '|---|---|---|---|',
        ...readings.map(
          (reading) =>
            `| ${reading.term} | ${cell(reading.sources.pubmed)} | ${cell(reading.sources.openalex)} | ${cell(reading.sources.arxiv)} |`
        ),
        '',
        `只有一个源命中的术语：**${onlyOne.length}** 条（${onlyOne.map((reading) => reading.term).join('、') || '无'}）`,
        '',
        '## 对照：直接发中文（抽样）',
        '',
        '| 术语 | 源 | 改写后 top-5 | 直接发中文 top-5 | 改写后总条数 | 直接发中文总条数 |',
        '|---|---|---|---|---|---|',
        ...control.flatMap((reading) =>
          sourceNames.map(
            (name) =>
              `| ${reading.term} | ${name} | ${cell(reading.sources[name])} | ${cell(reading.rawChinese?.[name] ?? emptySource())} | ${reading.sources[name].total ?? '—'} | ${reading.rawChinese?.[name].total ?? '—'} |`
          )
        ),
        '',
        '## 口径',
        '',
        '- 命中 = 该源返回的 top-5 标题里出现该英文术语（整词/短语、大小写不敏感）。总条数与命中是两个数，分开记。',
        '- 网络失败记成该源该条的具名错误，不记 0、不跳过。',
        '- 被拒绝的术语仍然发出去量了（为了对照），但产品实际行为是**拒绝并点名**，不发半截查询。',
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
      expect(
        readings.some((reading) => sourceNames.some((name) => reading.sources[name].top.length > 0))
      ).toBe(true)
      process.stdout.write(`\n落盘：docs/bench-runs/${stamp}-zh-alias-retrieval.{jsonl,md}\n`)
    },
    20 * 60_000
  )
})
