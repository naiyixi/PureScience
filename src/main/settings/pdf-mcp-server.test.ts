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
  PDF_TRANSLATE_TOOL_NAME,
  createPdfMcpServer,
  createPdfMcpServerConfig
} from './pdf-mcp-server'
import type { PdfMcpHandler } from './pdf-mcp-server'

const makeHandler = (): PdfMcpHandler => ({
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
  })),
  tables: vi.fn(async () => ({
    docId: 'doc-1',
    scannedPages: 1,
    candidates: []
  })),
  figures: vi.fn(async () => ({
    docId: 'doc-1',
    scannedPages: 0,
    figures: [],
    skippedSmall: 0,
    withoutCaption: 0
  })),
  translate: vi.fn(async () => ({
    docId: 'doc-1',
    targetLanguage: 'Simplified Chinese',
    pages: [
      {
        page: 1,
        paragraphs: [
          {
            id: 'p1#1',
            page: 1,
            paragraph: 1,
            status: 'translated' as const,
            source: 'Abstract',
            translation: '摘要'
          }
        ]
      }
    ],
    paragraphCount: 1,
    translated: 1,
    reused: 0,
    failed: [],
    skipped: 0,
    stopped: null,
    restored: { state: 'none' as const, reason: 'no-checkpoint' },
    emptyPages: [],
    checkpointPath: '/data/translations/abc.json'
  }))
})

describe('PDF MCP server contract', () => {
  it('names the server and its tools', () => {
    expect(PDF_MCP_SERVER_NAME).toBe('purescience_pdf')
    expect(PDF_MCP_SERVER_ARG).toBe('--purescience-pdf-mcp')
    expect(PDF_OPEN_TOOL_NAME).toBe('pdf_open')
    expect(PDF_PAGES_TOOL_NAME).toBe('pdf_pages')
    expect(PDF_OUTLINE_TOOL_NAME).toBe('pdf_outline')
    expect(PDF_SCAN_TOOL_NAME).toBe('pdf_scan')
    expect(PDF_TRANSLATE_TOOL_NAME).toBe('pdf_translate')
  })

  it('registers the tools with their handler wiring', () => {
    const handler = makeHandler()
    const server = createPdfMcpServer(handler)
    const tools = (server as unknown as { _registeredTools: Record<string, unknown> })
      ._registeredTools
    expect(Object.keys(tools)).toHaveLength(7)
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
    expect(config.name).toBe('purescience_pdf')
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
      handler: (
        input: Record<string, unknown>
      ) => Promise<{ content: { type: string; text: string }[] }>
    }
    const result = await openTool.handler({ path: '/data/paper.pdf' })
    expect(handler.open).toHaveBeenCalledWith('/data/paper.pdf')
    expect(result.content[0]?.text).toContain('docId')
  })

  it('passes only the translate options the caller actually gave', async () => {
    const handler = makeHandler()
    const server = createPdfMcpServer(handler)
    const tools = (server as unknown as { _registeredTools: Record<string, unknown> })
      ._registeredTools
    const translateTool = tools[PDF_TRANSLATE_TOOL_NAME] as {
      handler: (
        input: Record<string, unknown>
      ) => Promise<{ content: { type: string; text: string }[] }>
    }

    const minimal = await translateTool.handler({ doc_id: 'doc-1' })
    // Absent options must stay absent: a default the caller did not ask for here would translate a page
    // range nobody requested.
    expect(handler.translate).toHaveBeenCalledWith('doc-1', {})
    expect(minimal.content[0]?.text).toContain('p1#1')

    await translateTool.handler({
      doc_id: 'doc-1',
      target_language: 'French'
    })
    expect(handler.translate).toHaveBeenLastCalledWith('doc-1', {
      targetLanguage: 'French'
    })
  })
})
