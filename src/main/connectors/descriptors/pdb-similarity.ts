import type { ToolContext, ToolDescriptor } from '../types'

// PDB structure similarity, by the shape of the protein rather than the letters of its sequence.
//
// RCSB's public search API has no working structure-similarity service (measured 2026-11-02: `service:
// "structure"` answers 400 for every `entry_id` shape and 500 for `value`, while the same request shape with
// `service: "chemical"` answers 204). FoldSeek — the engine RCSB's own structure search is built on — takes
// the COORDINATES as an uploaded file, which is why this tool needs `postForm`. The flow is three steps and
// this build has not been able to measure it end-to-end from a developer machine (search.foldseek.com is
// intermittently unreachable from here), so the reading is taken on CI by `live-probes.test.ts` and printed
// into the job log rather than claimed here.
const RCSB_FILES = 'https://files.rcsb.org/download'
const FOLDSEEK = 'https://search.foldseek.com/api'

const DEFAULT_DATABASES = ['afdb50', 'pdb100']
const ALLOWED_DATABASES = ['afdb50', 'afdb-swissprot', 'pdb100', 'bfmd', 'afdb-proteome']
const MAX_POLLS = 10
const POLL_INTERVAL_MS = 1500

type FoldseekAlignment = {
  target?: string
  prob?: number
  evalue?: number
  score?: number
  qStartPos?: number
  qEndPos?: number
  dbStartPos?: number
  dbEndPos?: number
  qLen?: number
  dbLen?: number
  alnLen?: number
  tmscore?: number
  qtmscore?: number
  ttmscore?: number
  taxid?: number
  taxname?: string
}

type FoldseekResult = {
  status?: string
  id?: string
  results?: Array<{ alignments?: FoldseekAlignment[][] }>
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const fetchEntryCoordinates = async (ctx: ToolContext, id: string): Promise<string> => {
  const text = await ctx.fetchText(`${RCSB_FILES}/${id.toUpperCase()}.pdb`)
  if (!/^(ATOM|HETATM|HEADER|CRYST1)/m.test(text)) {
    throw new Error(`RCSB returned no coordinate records for ${id.toUpperCase()}.`)
  }
  return text
}

export const PDB_SIMILARITY_TOOLS: ToolDescriptor[] = [
  {
    id: 'pdb_structure_similarity',
    connector: 'structure-similarity',
    description:
      'Find structures whose 3D SHAPE is similar to a given PDB entry — shape, not sequence. Args: pdb_id (four characters, e.g. 1cbs), databases (1–2 of afdb50, afdb-swissprot, pdb100, bfmd, afdb-proteome; default afdb50+pdb100), max_hits (1–100, default 25). Returns {source, query, databases, n_hits, hits: [{target, probability, evalue, score, tmscore, qtmscore, ttmscore, aln_len, query_range, target_range}], incomplete} or a named error. `probability` is FoldSeek’s own confidence and `tmscore` is the structural agreement — a high score with a low probability is a short, common fold, which is why both are printed. An answer with `incomplete: true` means the search had not finished inside this call’s budget and the hits are what existed at that moment; call again to continue rather than reading it as the whole result. Requires network access to files.rcsb.org and search.foldseek.com.',
    input: {
      type: 'object',
      properties: {
        pdb_id: { type: 'string', description: 'PDB id, e.g. 1cbs' },
        databases: {
          type: 'array',
          items: { type: 'string', enum: ALLOWED_DATABASES },
          description: 'Which FoldSeek databases to search (1–2)'
        },
        max_hits: { type: 'integer', minimum: 1, maximum: 100, default: 25 }
      },
      required: ['pdb_id']
    },
    required: ['pdb_id'],
    returns:
      '{source, query, databases, n_hits, hits[], incomplete} or {error: argument-rejected|not-found|unavailable|unexpected-shape|source-unreadable, message}',
    example:
      'const result = await host.mcp("structure-similarity", "pdb_structure_similarity", {"pdb_id": "1cbs", "max_hits": 10})',
    format: 'json',
    run: async (ctx: ToolContext, a: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const pdbId = String(a.pdb_id ?? '')
        .trim()
        .toUpperCase()
      if (!/^[0-9][A-Z0-9]{3}$/.test(pdbId)) {
        return {
          error: 'argument-rejected',
          message: `"${pdbId}" is not a PDB id (four characters, first a digit).`
        }
      }
      if (!ctx.postForm) {
        return {
          error: 'unavailable',
          message:
            'This transport cannot upload a file, and FoldSeek takes coordinates rather than an id. Nothing was sent.'
        }
      }
      const requested = Array.isArray(a.databases)
        ? a.databases.map((d) => String(d))
        : DEFAULT_DATABASES
      const databases = [...new Set(requested.filter((d) => ALLOWED_DATABASES.includes(d)))]
      if (databases.length === 0) {
        return {
          error: 'argument-rejected',
          message: `databases must be drawn from ${ALLOWED_DATABASES.join(', ')}.`
        }
      }
      const maxHits = Math.max(1, Math.min(100, Math.trunc(Number(a.max_hits) || 25)))

      let coordinates: string
      try {
        coordinates = await fetchEntryCoordinates(ctx, pdbId)
      } catch (error) {
        return {
          error: 'not-found',
          message: error instanceof Error ? error.message : String(error)
        }
      }

      // Step 1 — upload the coordinates and get a ticket. `q` is a FILE field, which is the whole reason this
      // tool needed a multipart transport.
      const form = new FormData()
      form.append('q', new Blob([coordinates], { type: 'chemical/x-pdb' }), `${pdbId}.pdb`)
      // The field name is `database[]` — measured on a runner 2026-11-02: `database` answers
      // "Key: 'JobRequest.Job.Database' … failed on the 'required' tag", `database[]` answers a ticket.
      for (const database of databases) form.append('database[]', database)
      form.append('mode', '3diaa')

      let ticket: FoldseekResult
      try {
        ticket = (await ctx.postForm(`${FOLDSEEK}/ticket`, form)) as FoldseekResult
      } catch (error) {
        return {
          error: 'unavailable',
          message: `FoldSeek did not accept the search: ${error instanceof Error ? error.message : String(error)}`
        }
      }
      const ticketId = ticket?.id
      if (!ticketId) {
        return {
          error: 'unexpected-shape',
          message: `FoldSeek answered without a ticket id (${JSON.stringify(ticket).slice(0, 160)}).`
        }
      }

      // Step 2 — poll. Bounded on purpose: a tool call that waits forever is worse than one that says how far
      // it got, so an unfinished search returns `incomplete: true` with whatever existed.
      let result: FoldseekResult | undefined
      for (let poll = 0; poll < MAX_POLLS; poll++) {
        await sleep(POLL_INTERVAL_MS)
        try {
          result = (await ctx.fetchJson(
            `${FOLDSEEK}/result/${ticketId}?format=json`
          )) as FoldseekResult
        } catch {
          continue
        }
        if (result?.status === 'COMPLETE' || result?.status === 'ERROR') break
      }
      if (!result) {
        return {
          error: 'unavailable',
          message: `FoldSeek accepted the search (ticket ${ticketId}) but answered nothing within this call.`
        }
      }
      if (result.status === 'ERROR') {
        return {
          error: 'unavailable',
          message: `FoldSeek reported the search as failed (ticket ${ticketId}).`
        }
      }

      const alignments = (result.results ?? []).flatMap((entry) => entry.alignments ?? []).flat()
      const hits = alignments.slice(0, maxHits).map((hit) => ({
        target: hit.target ?? null,
        probability: hit.prob ?? null,
        evalue: hit.evalue ?? null,
        score: hit.score ?? null,
        tmscore: hit.tmscore ?? null,
        qtmscore: hit.qtmscore ?? null,
        ttmscore: hit.ttmscore ?? null,
        aln_len: hit.alnLen ?? null,
        query_range:
          hit.qStartPos != null && hit.qEndPos != null ? [hit.qStartPos, hit.qEndPos] : null,
        target_range:
          hit.dbStartPos != null && hit.dbEndPos != null ? [hit.dbStartPos, hit.dbEndPos] : null,
        taxonomy: hit.taxname ?? null
      }))

      return {
        source: 'FoldSeek (via RCSB coordinates)',
        query: pdbId,
        databases,
        n_hits: hits.length,
        incomplete: result.status !== 'COMPLETE',
        hits
      }
    }
  }
]
