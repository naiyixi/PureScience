import type { ToolContext, ToolDescriptor } from '../types'
import { searchArxiv } from './literature-arxiv'
import { searchOpenAlexWorks } from './literature-openalex'

/** One per-query result: merged records from both sources with per-source status. */
interface LiteratureSourceReport {
  status: 'ok' | 'error'
  n_records_returned: number
  api_total: number
  error?: string
}

interface LiteratureQueryResult {
  query: string
  sources: { arxiv: LiteratureSourceReport; openalex: LiteratureSourceReport }
  total_records: number
  records: Array<Record<string, unknown>>
}

// 多源并行文献综述: 一次调用同时检索 arXiv 预印本 + OpenAlex 学术图谱 (~2.5 亿条记录),
// 结果按来源合并 (每条记录带 source 标记), 单源失败不拖垮整体 (标记 error 继续返回其他源)。
// 对齐"多代理并行文献综述"思路 — 轻量实现 (工具内 Promise.all 并行,
// 而非完整的多 agent 编排)。
export const LITERATURE_REVIEW_TOOLS: ToolDescriptor[] = [
  {
    id: 'literature_review_search',
    connector: 'literature',
    description:
      'Parallel multi-source literature search across arXiv preprints and the OpenAlex scholarly graph (~250M works) in a single call. Args: query (required, free-text) OR queries (array of free-text queries — each runs in parallel as an independent sub-task across both sources, mimicking multi-agent parallel literature review), year_from / year_to (optional inclusive years, OpenAlex only), open_access_only (optional, OpenAlex only), max_per_source (default 10, hard ceiling 50 — each source returns at most this many records per query). Returns { results: [ { query, sources: { arxiv: {status, n_records_returned, api_total}, openalex: {status, n_records_returned, api_total} }, records: [{ source, ... }] } ] } — one entry per query (single-query calls return one entry). A source that fails (network/rate limit) is reported with status "error" and an error message while the other source still returns records.',
    input: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        queries: { type: 'array', items: { type: 'string' } },
        year_from: { type: 'integer' },
        year_to: { type: 'integer' },
        open_access_only: { type: 'boolean', default: false },
        max_per_source: { type: 'integer', default: 10 }
      },
      anyOf: [{ required: ['query'] }, { required: ['queries'] }]
    },
    required: [],
    returns:
      '`{ results: [ { query, sources: { arxiv: {status, n_records_returned, api_total, error?}, openalex: {status, n_records_returned, api_total, error?} }, records: [{ source, ... }] } ] }`',
    example:
      'const result = await host.mcp("literature", "literature_review_search", {"queries": ["CRISPR base editing", "prime editing 2024"], "max_per_source": 15})',
    run: async (ctx: ToolContext, a: Record<string, unknown>) => {
      const singleQuery = a.query != null ? String(a.query).trim() : ''
      const rawQueries = Array.isArray(a.queries) ? (a.queries as unknown[]).map(String) : []
      const queries = rawQueries.length > 0 ? rawQueries.map((q) => q.trim()).filter(Boolean) : []
      if (!singleQuery && queries.length === 0) {
        throw new Error('literature_review_search requires a query or a non-empty queries array')
      }
      const allQueries = singleQuery ? [singleQuery, ...queries] : queries
      const maxPerSource = Math.min(Math.max(Number(a.max_per_source ?? 10) || 10, 1), 50)
      const yearFrom = a.year_from != null ? Number(a.year_from) : undefined
      const yearTo = a.year_to != null ? Number(a.year_to) : undefined
      const openAccessOnly = a.open_access_only === true

      const runOne = async (q: string): Promise<LiteratureQueryResult> => {
        const [arxivResult, openalexResult] = await Promise.all([
          searchArxiv(ctx, { query: `all:${q}`, maxResults: maxPerSource }).then(
            (result) => ({ status: 'ok' as const, ...result }),
            (error: unknown) => ({
              status: 'error' as const,
              n_records_returned: 0,
              api_total: 0,
              error: error instanceof Error ? error.message : String(error)
            })
          ),
          searchOpenAlexWorks(ctx, {
            query: q,
            yearFrom,
            yearTo,
            openAccessOnly,
            maxRecords: maxPerSource
          }).then(
            (result) => ({ status: 'ok' as const, ...result }),
            (error: unknown) => ({
              status: 'error' as const,
              n_records_returned: 0,
              api_total: 0,
              error: error instanceof Error ? error.message : String(error)
            })
          )
        ])

        const arxivRecords =
          arxivResult.status === 'ok'
            ? arxivResult.records.map((record) => ({ source: 'arxiv' as const, ...record }))
            : []
        const openalexRecords =
          openalexResult.status === 'ok'
            ? openalexResult.records.map((record) => ({
                ...(record as Record<string, unknown>),
                source: 'openalex' as const
              }))
            : []

        return {
          query: q,
          sources: {
            arxiv: {
              status: arxivResult.status,
              n_records_returned: arxivResult.n_records_returned,
              api_total: arxivResult.api_total,
              ...(arxivResult.status === 'error' ? { error: arxivResult.error } : {})
            },
            openalex: {
              status: openalexResult.status,
              n_records_returned: openalexResult.n_records_returned,
              api_total: openalexResult.api_total,
              ...(openalexResult.status === 'error' ? { error: openalexResult.error } : {})
            }
          },
          total_records: arxivRecords.length + openalexRecords.length,
          records: [...arxivRecords, ...openalexRecords]
        }
      }

      const results = await Promise.all(allQueries.map((q) => runOne(q)))
      return { results }
    }
  }
]
