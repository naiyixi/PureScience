import { describe, expect, it } from 'vitest'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

import {
  classifyIdentifier,
  createLiteratureMcpServer,
  LITERATURE_CITE_TOOL,
  LITERATURE_GET_TOOL,
  LITERATURE_SEARCH_TOOL,
  type LiteratureMcpHandler
} from './mcp-server'
import type { LiteratureRecord } from './search'

const record: LiteratureRecord = {
  source: 'pubmed',
  title: 'Once-Weekly Semaglutide in Adults with Overweight or Obesity.',
  authors: ['Wilding JPH', 'Batterham RL'],
  year: 2021,
  venue: 'The New England journal of medicine',
  volume: '384',
  issue: '11',
  pages: '989-1002',
  doi: '10.1056/NEJMoa2032183',
  pmid: '33567185',
  pmcid: undefined,
  arxivId: undefined,
  url: 'https://pubmed.ncbi.nlm.nih.gov/33567185/',
  abstract: 'Semaglutide once weekly was tested.',
  read: 'Abstract'
}

const handler: LiteratureMcpHandler = {
  search: async (input) => ({ query: input.query, records: [record], errors: [] }),
  get: async (identifier) =>
    classifyIdentifier(identifier)?.value === '33567185' ? record : undefined
}

// The tools are exercised through a real MCP client over an in-memory transport: what the client receives here
// is the same JSON an external client would get, so the test covers the wire, not just the handler.
const withClient = async (run: (client: Client) => Promise<void>): Promise<void> => {
  const server = createLiteratureMcpServer(handler)
  const client = new Client({ name: 'test-client', version: '0.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  try {
    await run(client)
  } finally {
    await client.close()
    await server.close()
  }
}

const textOf = (result: { content: unknown }): string => {
  const [first] = result.content as Array<{ type: string; text: string }>
  return first?.text ?? ''
}

describe('classifyIdentifier', () => {
  it('routes each identifier shape to the reader that knows it', () => {
    expect(classifyIdentifier('10.1056/NEJMoa2032183')).toEqual({
      kind: 'doi',
      value: '10.1056/NEJMoa2032183'
    })
    expect(classifyIdentifier('https://doi.org/10.1038/527S101a')).toEqual({
      kind: 'doi',
      value: '10.1038/527S101a'
    })
    expect(classifyIdentifier('33567185')).toEqual({ kind: 'pmid', value: '33567185' })
    expect(classifyIdentifier('https://pubmed.ncbi.nlm.nih.gov/33567185/')).toEqual({
      kind: 'pmid',
      value: '33567185'
    })
    expect(classifyIdentifier('2103.14030')).toEqual({ kind: 'arxiv', value: '2103.14030' })
    expect(classifyIdentifier('https://arxiv.org/pdf/2103.14030v1.pdf')).toEqual({
      kind: 'arxiv',
      value: '2103.14030v1'
    })
    expect(classifyIdentifier('not an identifier')).toBeUndefined()
  })
})

describe('literature MCP server', () => {
  it('lists the three tools an external client can call', async () => {
    await withClient(async (client) => {
      const { tools } = await client.listTools()
      expect(tools.map((tool) => tool.name).sort()).toEqual(
        [LITERATURE_CITE_TOOL, LITERATURE_GET_TOOL, LITERATURE_SEARCH_TOOL].sort()
      )
      const search = tools.find((tool) => tool.name === LITERATURE_SEARCH_TOOL)
      expect(search?.description).toContain('PubMed')
      expect(JSON.stringify(search?.inputSchema)).toContain('query')
    })
  })

  it('returns records from a search, with what was read on each', async () => {
    await withClient(async (client) => {
      const result = await client.callTool({
        name: LITERATURE_SEARCH_TOOL,
        arguments: { query: 'semaglutide' }
      })
      const payload = JSON.parse(textOf(result as { content: unknown })) as {
        records: LiteratureRecord[]
      }
      expect(payload.records).toHaveLength(1)
      expect(payload.records[0]?.read).toBe('Abstract')
    })
  })

  it('cites a resolved identifier and says where the text came from', async () => {
    await withClient(async (client) => {
      const result = await client.callTool({
        name: LITERATURE_CITE_TOOL,
        arguments: { identifier: '33567185' }
      })
      const payload = JSON.parse(textOf(result as { content: unknown })) as {
        citation: string
        location: { read: string; url: string }
        identifiers: { doi: string | null }
      }
      expect(payload.citation).toContain('Once-Weekly Semaglutide')
      expect(payload.citation).toContain('doi:10.1056/NEJMoa2032183')
      expect(payload.location.read).toBe('Abstract')
      expect(payload.location.url).toBe('https://pubmed.ncbi.nlm.nih.gov/33567185/')
      expect(payload.identifiers.doi).toBe('10.1056/NEJMoa2032183')
    })
  })

  it('says so plainly when an identifier is not one it understands', async () => {
    await withClient(async (client) => {
      const result = await client.callTool({
        name: LITERATURE_GET_TOOL,
        arguments: { identifier: 'loose words' }
      })
      const payload = JSON.parse(textOf(result as { content: unknown })) as { error: string }
      expect(payload.error).toBe('unrecognised-identifier')
    })
  })
})
