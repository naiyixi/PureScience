import type { ToolContext, ToolDescriptor } from '../types'

// ENCORI (the starBase successor, Sun Yat-sen University) exposes its tables over a documented HTTP API —
// https://rnasysu.com/encori/api/<module>/?<params> (see the service's own tutorialAPI page) — answered as
// a TAB-DELIMITED table whose own header row names the columns. Two comment lines ("#please cite:",
// "#<citation>") precede that header; they are kept rather than dropped, because the service asks to be
// cited and the citation is part of the answer.
const ENCORI_BASE = 'https://rnasysu.com/encori/api'

const ENCORI_GENE_TYPES = ['mRNA', 'lncRNA', 'circRNA', 'pseudogene', 'sncRNA']

function strArg(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function clampInt(v: unknown, def: number, lo: number, hi: number): number {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return def
  return Math.min(hi, Math.max(lo, Math.trunc(n)))
}

// The columns this reader names on a row. The service's header row is returned verbatim as `columns`, so a
// column the service adds stays visible even though this reader does not know it; a column it stops sending
// is named in `absent_columns` instead of being silently absent from every row.
const ENCORI_MIRNA_TARGET_COLUMNS = [
  'miRNAid',
  'miRNAname',
  'geneID',
  'geneName',
  'geneType',
  'chromosome',
  'narrowStart',
  'narrowEnd',
  'broadStart',
  'broadEnd',
  'strand',
  'clipExpNum',
  'degraExpNum',
  'RBP',
  'PITA',
  'RNA22',
  'miRmap',
  'microT',
  'miRanda',
  'PicTar',
  'TargetScan',
  'TDMDScore',
  'phyloP',
  'pancancerNum',
  'cellline/tissue'
]

export const RNA_ENCORI_TOOLS: ToolDescriptor[] = [
  {
    id: 'encori_mirna_target',
    connector: 'rna-encori',
    description:
      'The miRNA-target table of ENCORI (the starBase successor): which miRNAs the catalogue lists for one gene, with the support each row carries — CLIP experiment count (clipExpNum), degradome count (degraExpNum), the RBP(s) bound, and how many cancer types the pair was seen in (pancancerNum) plus the cell lines/tissues (cellline/tissue). Use it for miRNA-target evidence questions ("which miRNAs are reported to target TP53", "is hsa-miR-21-5p reported to target TP53"). Args: target (gene symbol like TP53 or ENSEMBL id — required); mirna (a name like hsa-miR-21-5p, or "all" to ask for every miRNA the table lists for that gene; default all); gene_type (mRNA, lncRNA, circRNA, pseudogene or sncRNA; default mRNA); assembly (hg38 or mm10; default hg38); clip_exp_num / degra_exp_num / pancancer_num (minimum support the service should require); max_rows (1-2000, default 200). Returns {source, request, citation: [...], columns (the header the service sent, verbatim), absent_columns, n_rows_returned, n_rows_in_response, truncated, rows, note}. Every support number is the service\'s own; this reader does not score, rank, or call any row a regulation. Requires network access to rnasysu.com.',
    input: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: 'Gene symbol (TP53) or ENSEMBL gene id (ENSG00000141510).'
        },
        mirna: { type: 'string', description: 'miRNA name (hsa-miR-21-5p) or "all". Default all.' },
        gene_type: { type: 'string', enum: ENCORI_GENE_TYPES, default: 'mRNA' },
        assembly: { type: 'string', enum: ['hg38', 'mm10'], default: 'hg38' },
        clip_exp_num: { type: 'integer', minimum: 0, maximum: 1000, default: 1 },
        degra_exp_num: { type: 'integer', minimum: 0, maximum: 1000, default: 0 },
        pancancer_num: { type: 'integer', minimum: 0, maximum: 1000, default: 0 },
        max_rows: { type: 'integer', minimum: 1, maximum: 2000, default: 200 }
      },
      required: ['target']
    },
    required: ['target'],
    returns:
      '{source, request, citation, columns, absent_columns, n_rows_returned, n_rows_in_response, truncated, rows: [{miRNAid, miRNAname, geneID, geneName, strand, clipExpNum, degraExpNum, RBP, pancancerNum, cellline/tissue, …}], note} or a named error (target-required / unsupported-assembly / unsupported-gene-type) raised before any request.',
    example:
      'const result = await host.mcp("rna-encori", "encori_mirna_target", {"target": "TP53"})',
    run: async (ctx: ToolContext, a: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const target = strArg(a.target)
      // A gene is the one thing this table cannot be asked without; everything else has a documented default.
      if (target === '') {
        return {
          error: 'target-required',
          message: 'Name one gene (symbol or ENSEMBL id) whose targeting miRNAs you want.'
        }
      }
      const assembly = strArg(a.assembly) || 'hg38'
      if (assembly !== 'hg38' && assembly !== 'mm10') {
        return {
          error: 'unsupported-assembly',
          message: `ENCORI ships hg38 and mm10; got: ${assembly}`
        }
      }
      const geneType = strArg(a.gene_type) || 'mRNA'
      if (!ENCORI_GENE_TYPES.includes(geneType)) {
        return {
          error: 'unsupported-gene-type',
          message: `ENCORI geneType is one of ${ENCORI_GENE_TYPES.join(', ')}; got: ${geneType}`
        }
      }
      const mirna = strArg(a.mirna) || 'all'
      const clip = clampInt(a.clip_exp_num, 1, 0, 1000)
      const degra = clampInt(a.degra_exp_num, 0, 0, 1000)
      const pancancer = clampInt(a.pancancer_num, 0, 0, 1000)
      const maxRows = clampInt(a.max_rows, 200, 1, 2000)

      const url =
        `${ENCORI_BASE}/miRNATarget/?assembly=${assembly}&geneType=${geneType}&miRNA=${encodeURIComponent(mirna)}` +
        `&clipExpNum=${clip}&degraExpNum=${degra}&pancancerNum=${pancancer}&target=${encodeURIComponent(target)}`
      const text = await ctx.fetchText(url)

      const lines = text.split(/\r?\n/)
      const citation = lines
        .filter((line) => line.startsWith('#'))
        .map((line) => line.replace(/^#/, '').trim())
      const table = lines.filter((line) => line.trim() !== '' && !line.startsWith('#'))
      const columns = table.length === 0 ? [] : table[0].split('\t').map((cell) => cell.trim())
      // The service answers HTTP 200 even when its own database is down: the body is then its PHP warning
      // ("Connect to database fail!"), not the table. Parsing that would print rows for an outage, so a body
      // that is not the table is refused BY NAME, quoting what the service actually said.
      const notATable =
        citation.length === 0 || columns.length < 2 || /<[a-z!/]/i.test(table[0] ?? '')
      if (notATable) {
        return {
          error: 'source-unreadable',
          message: `ENCORI answered with something that is not its table: ${lines
            .filter((line) => line.trim() !== '')
            .join(' ')
            .slice(0, 300)}`
        }
      }
      const dataRows = table.slice(1).map((line) => line.split('\t'))
      const rows = dataRows.slice(0, maxRows).map((cells) => {
        const row: Record<string, string> = {}
        for (const name of ENCORI_MIRNA_TARGET_COLUMNS) {
          const index = columns.indexOf(name)
          if (index >= 0) row[name] = cells[index] ?? ''
        }
        return row
      })

      return {
        source: 'ENCORI (rnasysu.com) - miRNA-Target module',
        request: {
          module: 'miRNATarget',
          assembly,
          gene_type: geneType,
          mirna,
          clip_exp_num: clip,
          degra_exp_num: degra,
          pancancer_num: pancancer,
          target
        },
        citation,
        columns,
        absent_columns: ENCORI_MIRNA_TARGET_COLUMNS.filter((name) => !columns.includes(name)),
        n_rows_returned: rows.length,
        // The service reports no total, so this counts the rows THIS response carried. It is not a claim
        // about how many pairs exist in the table.
        n_rows_in_response: dataRows.length,
        truncated: dataRows.length > rows.length,
        rows,
        ...(rows.length === 0
          ? {
              note: 'The service returned no rows under these filters. That is this table saying it has none under them - not a statement that no interaction exists.'
            }
          : {})
      }
    }
  }
]
