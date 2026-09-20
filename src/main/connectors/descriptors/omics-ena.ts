import type { ToolContext, ToolDescriptor } from '../types'

// ENA runs and their FASTQ files — metadata and reachability, never the file itself.
//
// The discipline this connector follows is the audit's: a sequencing archive is not a place to download
// hundreds of megabytes and call it analysis. So these tools answer two questions and stop there — what
// does the archive say about this run, and are the files it lists actually reachable right now — and they
// report the checksums the archive publishes as *declared* values, because verifying an MD5 means reading
// the whole file, which is exactly what is not being done here.
//
// HEAD requests go through the global fetch rather than the tool context: the context's helpers parse a
// body, which a reachability probe must not do (the same reason the Reactome descriptor bypasses it).
const ENA_PORTAL = 'https://www.ebi.ac.uk/ena/portal/api'
const USER_AGENT = 'PureScience/1.0 (+https://github.com/zerolink/purescience)'
const HEAD_TIMEOUT_MS = 20_000
const DEFAULT_LIMIT = 25
const MAX_LIMIT = 200

// The fields the portal returns for a run; kept explicit so the shape is stable across ENA's catalogue.
const RUN_FIELDS = [
  'run_accession',
  'study_accession',
  'sample_accession',
  'experiment_accession',
  'scientific_name',
  'library_strategy',
  'library_layout',
  'instrument_platform',
  'instrument_model',
  'read_count',
  'base_count',
  'fastq_ftp',
  'fastq_bytes',
  'fastq_md5',
  'submitted_ftp',
  'first_public'
] as const

type Obj = Record<string, unknown>
const asObj = (value: unknown): Obj =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Obj) : {}
const asArr = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
const text = (value: unknown): string | undefined => {
  const trimmed = value === undefined || value === null ? '' : String(value).trim()
  return trimmed === '' ? undefined : trimmed
}
const intOrNull = (value: unknown): number | null => {
  const trimmed = value === undefined || value === null ? '' : String(value).trim()
  if (trimmed === '') return null
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null
}
// ENA packs several files into one field as semicolon-separated lists.
const splitList = (value: unknown): string[] =>
  (text(value) ?? '')
    .split(';')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')

const normalizeLimit = (value: unknown): number => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT
  return Math.min(Math.floor(parsed), MAX_LIMIT)
}

export type EnaFileProbe = {
  url: string
  /** Bytes ENA declares for this file. */
  declared_bytes: number | null
  /** MD5 ENA declares — a claim, not something this tool verifies. */
  declared_md5?: string
  reachable: boolean
  status?: number
  /** Content-Length the server answered with, when it answered. */
  reported_bytes?: number | null
  bytes_match_declared?: boolean
  error?: string
}

const probeFile = async (url: string, declaredBytes: number | null): Promise<Omit<EnaFileProbe, 'declared_md5'>> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), HEAD_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      method: 'HEAD',
      headers: { 'user-agent': USER_AGENT },
      signal: controller.signal
    })
    const header = response.headers?.get?.('content-length') ?? null
    const reported = header === null ? null : Number(header)
    return {
      url,
      declared_bytes: declaredBytes,
      reachable: response.ok,
      status: response.status,
      reported_bytes: Number.isFinite(reported) ? reported : null,
      ...(declaredBytes === null || !Number.isFinite(reported)
        ? {}
        : { bytes_match_declared: reported === declaredBytes })
    }
  } catch (error) {
    return {
      url,
      declared_bytes: declaredBytes,
      reachable: false,
      error: error instanceof Error ? error.message : String(error)
    }
  } finally {
    clearTimeout(timer)
  }
}

const rowOf = (raw: unknown): Record<string, unknown> => {
  const record = asObj(raw)
  return {
    run_accession: text(record.run_accession) ?? '',
    study_accession: text(record.study_accession) ?? '',
    sample_accession: text(record.sample_accession) ?? '',
    experiment_accession: text(record.experiment_accession) ?? '',
    scientific_name: text(record.scientific_name) ?? '',
    library_strategy: text(record.library_strategy) ?? '',
    library_layout: text(record.library_layout) ?? '',
    instrument_platform: text(record.instrument_platform) ?? '',
    instrument_model: text(record.instrument_model) ?? '',
    read_count: intOrNull(record.read_count),
    base_count: intOrNull(record.base_count),
    fastq_urls: splitList(record.fastq_ftp).map((entry) =>
      entry.startsWith('http') ? entry : `https://${entry}`
    ),
    declared_bytes: splitList(record.fastq_bytes).map((entry) => intOrNull(entry)),
    declared_md5: splitList(record.fastq_md5),
    first_public: text(record.first_public) ?? ''
  }
}

export const OMICS_ENA_TOOLS: ToolDescriptor[] = [
  {
    id: 'ena_search_runs',
    connector: 'omics_archives',
    description:
      'Search ENA (European Nucleotide Archive) for sequencing runs by study, sample, accession or free text, and return each run\u2019s metadata: its own and its parent accessions, organism, library strategy/layout, platform and model, read and base counts, and the FASTQ URLs with the **sizes and MD5s ENA declares** for them. The checksums are the archive\u2019s claims, not something this tool verifies — verifying an MD5 means reading the whole file, which is deliberately left to a caller that has decided to download. Use ena_run_files to check reachability for a specific run.',
    input: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'ENA portal query, e.g. "study_accession=PRJEB12345", "run_accession=ERR123456", "tax_eq(9606)".'
        },
        limit: { type: 'number', description: `Rows to return, default ${String(DEFAULT_LIMIT)}, max ${String(MAX_LIMIT)}.` },
        result: { type: 'string', description: 'ENA result type, default read_run.' }
      },
      required: ['query']
    },
    returns:
      '{query, result, limit, returned, truncated, runs:[{run_accession, study_accession, sample_accession, experiment_accession, scientific_name, library_strategy, library_layout, instrument_platform, instrument_model, read_count, base_count, fastq_urls, declared_bytes, declared_md5, first_public}], notes}',
    example:
      'const result = await host.mcp("omics-archives", "ena_search_runs", {"query": "study_accession=PRJEB12345", "limit": 10})',
    run: async (ctx: ToolContext, a: Record<string, unknown>) => {
      const query = text(a.query)
      if (!query) throw new Error('ena_search_runs needs a query.')
      const result = text(a.result) ?? 'read_run'
      const limit = normalizeLimit(a.limit)
      const url =
        `${ENA_PORTAL}/search?result=${encodeURIComponent(result)}` +
        `&query=${encodeURIComponent(query)}` +
        `&fields=${encodeURIComponent(RUN_FIELDS.join(','))}` +
        `&format=json&limit=${String(limit)}`
      const raw = await ctx.fetchText(url)
      // An empty body is how the portal says "nothing matched"; it is not an error, but it is reported as
      // such rather than as an empty success.
      const parsed = raw.trim() === '' ? [] : (JSON.parse(raw) as unknown)
      const rows = asArr(parsed)
      return {
        query,
        result,
        limit,
        returned: rows.length,
        truncated: rows.length >= limit,
        runs: rows.map(rowOf),
        notes: [
          'declared_md5/declared_bytes 是 ENA 自己声明的值，本工具**不下载文件**、因此不会替你验证它们。',
          rows.length >= limit
            ? `本次返回达到上限 ${String(limit)}，结果可能被截断（truncated=true）；需要更多请提高 limit（最大 ${String(MAX_LIMIT)}）或细化 query。`
            : '返回条数未触及上限。'
        ]
      }
    }
  },
  {
    id: 'ena_run_files',
    connector: 'omics_archives',
    description:
      'List the FASTQ files of one ENA run and check whether they are reachable right now, without downloading them: each file comes back with the URL, the size and MD5 ENA declares, and the result of a HEAD probe (status, the Content-Length the server reports, and whether that matches the declared size). Use this to decide whether a download would work before committing to it. The MD5 stays a declared value — verifying it means reading the file, which is exactly what this tool does not do.',
    input: {
      type: 'object',
      properties: {
        run_accession: { type: 'string', description: 'Run accession, e.g. ERR123456.' },
        verify: { type: 'boolean', description: 'Probe each file with HEAD, default true.' }
      },
      required: ['run_accession']
    },
    returns:
      '{run_accession, scientific_name, library_layout, files:[{url, declared_bytes, declared_md5, reachable, status?, reported_bytes?, bytes_match_declared?, error?}], all_reachable, bytes_match, notes}',
    example:
      'const result = await host.mcp("omics-archives", "ena_run_files", {"run_accession": "ERR123456"})',
    run: async (ctx: ToolContext, a: Record<string, unknown>) => {
      const runAccession = text(a.run_accession)
      if (!runAccession) throw new Error('ena_run_files needs a run accession.')
      const verify = a.verify !== false
      const url =
        `${ENA_PORTAL}/search?result=read_run` +
        `&query=${encodeURIComponent(`run_accession=${runAccession}`)}` +
        `&fields=${encodeURIComponent('run_accession,scientific_name,library_layout,fastq_ftp,fastq_bytes,fastq_md5')}` +
        `&format=json&limit=1`
      const rows = asArr(JSON.parse((await ctx.fetchText(url)) || '[]'))
      const record = asObj(rows[0])
      if (Object.keys(record).length === 0) {
        throw new Error(`ENA has no run ${runAccession}.`)
      }
      const row = rowOf(record)
      const declaredBytes = row.declared_bytes as (number | null)[]
      const declaredMd5 = row.declared_md5 as string[]
      const urls = row.fastq_urls as string[]

      const files: EnaFileProbe[] = []
      for (const [index, fileUrl] of urls.entries()) {
        const bytes = declaredBytes[index] ?? null
        if (!verify) {
          files.push({
            url: fileUrl,
            declared_bytes: bytes,
            ...(declaredMd5[index] === undefined ? {} : { declared_md5: declaredMd5[index] }),
            reachable: false
          })
          continue
        }
        const probe = await probeFile(fileUrl, bytes)
        files.push({
          ...probe,
          ...(declaredMd5[index] === undefined ? {} : { declared_md5: declaredMd5[index] })
        })
      }

      const reachable = files.filter((file) => file.reachable)
      const matched = files.filter((file) => file.bytes_match_declared === true)
      const notes = [
        '只做元数据与可达性核验：HEAD 探测不会下载文件体，MD5 仍是 ENA 声明的值。',
        verify ? '每个文件都做过 HEAD 探测。' : 'verify=false：未做可达性探测，reachable 一律为 false（未核验，非不可达）。'
      ]
      if (verify && reachable.length < files.length) {
        notes.push(
          `有 ${String(files.length - reachable.length)} 个文件当前不可达；在承诺下载前请先解决。`
        )
      }
      if (verify && matched.length < reachable.length) {
        notes.push(
          '部分可达文件的 Content-Length 与 ENA 声明的字节数不一致，下载前应查明原因。'
        )
      }
      if (files.length === 0) {
        notes.push('该 run 没有 ENA 托管的 FASTQ 文件（可能只提交了 BAM/CRAM，或在 submitted_ftp 下）。')
      }

      return {
        run_accession: row.run_accession as string,
        scientific_name: row.scientific_name as string,
        library_layout: row.library_layout as string,
        files,
        all_reachable: files.length > 0 && reachable.length === files.length,
        bytes_match: files.length > 0 && matched.length === reachable.length,
        notes
      }
    }
  }
]
