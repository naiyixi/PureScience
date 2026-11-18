// External-facing literature MCP server: search PubMed / arXiv / Crossref, resolve one identifier, and hand
// back a citation that says what was actually read.
//
// Why this one runs without the app: the bundled connector descriptors do the same retrieval inside the agent
// process, but they parse with `DOMParser`, which Node does not have — and an external client (Claude Desktop,
// Cursor, a script) must not need the desktop UI running to ask a question about a paper. So the retrieval is
// re-implemented DOM-free in `./search.ts`, and this server exposes it over stdio.
//
// The tools deliberately return `read: 'Abstract' | 'Metadata only'` on every record. A caller that cites a
// record whose metadata was never opened can see that from the payload instead of assuming a full text.

import { McpServer as ModelContextProtocolServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

import {
  asDoi,
  formatCitation,
  lookupArxivId,
  lookupDoi,
  searchLiterature,
  searchPubMed,
  type FetchLike,
  type LiteratureRecord,
  type LiteratureSearchResult
} from './search'

export const LITERATURE_MCP_SERVER_NAME = 'purescience-literature'
export const LITERATURE_MCP_SERVER_ARG = '--purescience-literature-mcp'

export const LITERATURE_SEARCH_TOOL = 'literature_search'
export const LITERATURE_GET_TOOL = 'literature_get'
export const LITERATURE_CITE_TOOL = 'literature_cite'

const SOURCES = ['pubmed', 'arxiv'] as const

const searchSchema = {
  query: z.string().min(1).max(512).describe('Search terms, or a DOI to resolve it directly.'),
  sources: z
    .array(z.enum(SOURCES))
    .optional()
    .describe(
      'Which indexes to ask. Defaults to both PubMed and arXiv; a DOI query always resolves through Crossref.'
    ),
  limit: z.number().int().min(1).max(50).optional().describe('Records per source (default 10).')
}

const getSchema = {
  identifier: z
    .string()
    .min(1)
    .max(512)
    .describe('A DOI (10.x/…), a PMID, an arXiv id (2103.14030), or a PubMed/arXiv URL.')
}

export type LiteratureMcpHandler = {
  search: (input: {
    query: string
    sources?: (typeof SOURCES)[number][]
    limit?: number
  }) => Promise<LiteratureSearchResult>
  get: (identifier: string) => Promise<LiteratureRecord | undefined>
}

const PUBMED_URL = /^https?:\/\/(www\.)?pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)/iu
const ARXIV_URL = /^https?:\/\/arxiv\.org\/(abs|pdf)\/([^/?#]+)/iu
const PMID = /^\d{4,9}$/u
const ARXIV_ID = /^\d{4}\.\d{4,5}(v\d+)?$/u

/** Classifies what the caller pasted, so `literature_get` can route without the caller knowing the scheme. */
export const classifyIdentifier = (
  input: string
):
  | { kind: 'doi'; value: string }
  | { kind: 'pmid'; value: string }
  | { kind: 'arxiv'; value: string }
  | undefined => {
  const trimmed = input.trim()
  const doi = asDoi(trimmed)
  if (doi !== undefined) return { kind: 'doi', value: doi }

  const pubmed = PUBMED_URL.exec(trimmed)
  if (pubmed?.[2] !== undefined) return { kind: 'pmid', value: pubmed[2] }
  if (PMID.test(trimmed)) return { kind: 'pmid', value: trimmed }

  const arxiv = ARXIV_URL.exec(trimmed)
  if (arxiv?.[2] !== undefined) return { kind: 'arxiv', value: arxiv[2].replace(/\.pdf$/u, '') }
  if (ARXIV_ID.test(trimmed)) return { kind: 'arxiv', value: trimmed }

  return undefined
}

const createHandler = (fetchImpl: FetchLike | undefined): LiteratureMcpHandler => {
  const get: LiteratureMcpHandler['get'] = async (identifier) => {
    const classified = classifyIdentifier(identifier)
    if (classified === undefined) return undefined
    if (classified.kind === 'doi')
      return lookupDoi(classified.value, fetchImpl ?? (fetch as unknown as FetchLike))
    if (classified.kind === 'pmid') {
      const records = await searchPubMed(
        classified.value,
        1,
        fetchImpl ?? (fetch as unknown as FetchLike)
      )
      return records[0]
    }
    return lookupArxivId(classified.value, fetchImpl ?? (fetch as unknown as FetchLike))
  }

  return {
    search: async (input) => searchLiterature({ ...input, fetchImpl }),
    get
  }
}

// A failing index must arrive as data: an MCP client that receives a thrown error has to guess whether the
// query was wrong or the network was, and most render it as a bare "tool failed".
const guarded = async <T>(
  call: () => Promise<T>
): Promise<T | { error: 'call-failed'; detail: string }> => {
  try {
    return await call()
  } catch (error) {
    return { error: 'call-failed', detail: error instanceof Error ? error.message : String(error) }
  }
}

export const createLiteratureMcpServer = (
  handler: LiteratureMcpHandler
): ModelContextProtocolServer => {
  const server = new ModelContextProtocolServer({
    name: LITERATURE_MCP_SERVER_NAME,
    version: '1.0.0'
  })

  server.registerTool(
    LITERATURE_SEARCH_TOOL,
    {
      title: 'Search the literature',
      description:
        'Search PubMed and arXiv (or resolve a DOI through Crossref). Returns bibliographic records, each saying whether its abstract was actually read or only its metadata. Sources that fail are reported in `errors` without failing the call.',
      inputSchema: searchSchema
    },
    async (input) => ({
      content: [
        { type: 'text', text: JSON.stringify(await guarded(() => handler.search(input)), null, 2) }
      ]
    })
  )

  server.registerTool(
    LITERATURE_GET_TOOL,
    {
      title: 'Fetch one reference',
      description:
        'Resolve a DOI, PMID, arXiv id, or a PubMed/arXiv URL to one record. Returns nothing (with a message) when the identifier is not one of those.',
      inputSchema: getSchema
    },
    async (input) => {
      const record = await guarded(() => handler.get(input.identifier))
      const payload =
        record === undefined
          ? {
              error: 'unrecognised-identifier',
              detail: 'Pass a DOI (10.x/…), a PMID, an arXiv id, or a PubMed/arXiv URL.'
            }
          : record
      return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] }
    }
  )

  server.registerTool(
    LITERATURE_CITE_TOOL,
    {
      title: 'Cite one reference',
      description:
        'Resolve an identifier and return a ready-to-paste citation plus the link a reader can open. The citation contains only the fields the record carries — nothing is filled in.',
      inputSchema: getSchema
    },
    async (input) => {
      const record = await guarded(() => handler.get(input.identifier))
      // A failed index and an unreadable identifier are different answers; collapsing them would tell a caller
      // to check their identifier when the network was down.
      if (record === undefined || 'error' in record) {
        const payload = record ?? { error: 'unrecognised-identifier' }
        return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] }
      }
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                citation: formatCitation(record),
                // Where the text behind that citation was read from, so a reader can check it.
                location: { read: record.read, url: record.url, source: record.source },
                identifiers: {
                  doi: record.doi ?? null,
                  pmid: record.pmid ?? null,
                  pmcid: record.pmcid ?? null,
                  arxivId: record.arxivId ?? null
                }
              },
              null,
              2
            )
          }
        ]
      }
    }
  )

  return server
}

/** Runs the server over stdio, the transport every external MCP client speaks to a child process. */
export const runLiteratureMcpServer = async (fetchImpl?: FetchLike): Promise<void> => {
  const server = createLiteratureMcpServer(createHandler(fetchImpl))
  await server.connect(new StdioServerTransport())
}
