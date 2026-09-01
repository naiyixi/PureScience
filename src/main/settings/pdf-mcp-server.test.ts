// PDF-explore MCP server unit tests: contract surface (server name/arg/env wiring) and tool
// identity, mirroring the annotation MCP server test style.

import { describe, expect, it, vi } from 'vitest'

import {
  PDF_MCP_SERVER_ARG,
  PDF_MCP_SERVER_NAME,
  PDF_OPEN_TOOL_NAME,
  PDF_OUTLINE_TOOL_NAME,
  PDF_PAGES_TOOL_NAME,
  PDF_SCAN_TOOL_NAME,
  createPdfMcpServer,
  createPdfMcpServerConfig
} from './pdf-mcp-server'

const makeHandler = () => ({
  open: vi.fn(async () => ({
    doc: { docId: 'doc-1', title: 'paper', pageCount: 3, outline: [] },
    textPageCount: 3,
    emptyPageCount: 0
  })),
  pages: vi.fn(async () => ({
    docId: 'doc-1',
    start: 1,
    end: 1,
    pages: [{ page: 1, text: 'page one' }]
  })),
  outline: vi.fn(async () => ({
    docId: 'doc-1',
    title: 'paper',
    pageCount: 3,
    outline: [{ title: 'Intro', page: 1, level: 1 }]
  })),
  scan: vi.fn(async () => ({
    docId: 'doc-1',
    query: 'query',
    hits: [{ page: 2, score: 1, snippet: 'hit' }]
  }))
})

describe('PDF MCP server contract', () => {
  it('names the server and the four tools', () => {
    expect(PDF_MCP_SERVER_NAME).toBe('purescience-pdf')
    expect(PDF_MCP_SERVER_ARG).toBe('--purescience-pdf-mcp')
    expect(PDF_OPEN_TOOL_NAME).toBe('pdf_open')
    expect(PDF_PAGES_TOOL_NAME).toBe('pdf_pages')
    expect(PDF_OUTLINE_TOOL_NAME).toBe('pdf_outline')
    expect(PDF_SCAN_TOOL_NAME).toBe('pdf_scan')
  })

  it('registers the tools with their handler wiring', () => {
    const handler = makeHandler()
    const server = createPdfMcpServer(handler)
    const tools = (server as unknown as { _registeredTools: Record<string, unknown> })
      ._registeredTools
    expect(Object.keys(tools)).toHaveLength(4)
    expect(handler.open).not.toHaveBeenCalled()
  })

  it('builds a stdio server config with the pdf env', () => {
    const config = createPdfMcpServerConfig({
      command: '/usr/local/bin/purescience',
      entryPath: '/app/out/main/index.js',
      endpoint: 'http://127.0.0.1:8642',
      token: 'tok-123',
      sessionId: 'session-9',
      projectId: 'project-1'
    })
    expect(config.name).toBe('purescience-pdf')
    expect(config.args).toEqual(['/app/out/main/index.js', '--purescience-pdf-mcp'])
    const env = Object.fromEntries((config.env ?? []).map((entry) => [entry.name, entry.value]))
    expect(env.PURESCIENCE_PDF_RPC_ENDPOINT).toBe('http://127.0.0.1:8642')
    expect(env.PURESCIENCE_PDF_PROJECT_ID).toBe('project-1')
  })

  it('round-trips an open call through the handler', async () => {
    const handler = makeHandler()
    const server = createPdfMcpServer(handler)
    const tools = (server as unknown as { _registeredTools: Record<string, unknown> })
      ._registeredTools
    const openTool = tools[PDF_OPEN_TOOL_NAME] as {
      handler: (input: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[] }>
    }
    const result = await openTool.handler({ path: '/data/paper.pdf' })
    expect(handler.open).toHaveBeenCalledWith('/data/paper.pdf')
    expect(result.content[0]?.text).toContain('docId')
  })
})
