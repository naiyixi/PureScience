// Agent-facing PDF-explore MCP server: registers a PDF for layered reading (pdf_open), reads
// page ranges as text (pdf_pages), lists the table of contents (pdf_outline), and finds
// relevant pages by term frequency (pdf_scan). The MCP process runs as a stdio child of the
// agent; parsing + persistence live in the main process over the app's local RPC gateway (same
// pattern as annotations), so the store keeps a single writer.

import type { McpServerStdio } from '@agentclientprotocol/sdk'
import { McpServer as ModelContextProtocolServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

import {
  PDF_MCP_SERVER_NAME,
  PDF_OPEN_TOOL_DESCRIPTION,
  PDF_OPEN_TOOL_NAME,
  PDF_OUTLINE_TOOL_DESCRIPTION,
  PDF_OUTLINE_TOOL_NAME,
  PDF_PAGES_TOOL_DESCRIPTION,
  PDF_PAGES_TOOL_NAME,
  PDF_SCAN_TOOL_DESCRIPTION,
  PDF_SCAN_TOOL_NAME
} from '../../shared/pdf'
import type {
  PdfOpenResult,
  PdfOutlineResult,
  PdfPagesResult,
  PdfScanResult
} from '../../shared/pdf'
import { fetchLocalRpc, type LocalRpcTransport } from '../local-rpc-transport'
import { PDF_MCP_SERVER_ARG } from '../mcp-server-args'

const pdfOpenToolSchema = {
  path: z
    .string()
    .min(1)
    .max(4096)
    .describe('PDF path, relative to the current project root (or an authorized absolute path).')
}
const pdfOpenToolDefinition = {
  title: 'Register a PDF for layered reading',
  description: PDF_OPEN_TOOL_DESCRIPTION,
  inputSchema: pdfOpenToolSchema
}

const pdfPagesToolSchema = {
  doc_id: z.string().min(1).describe('Document id from pdf_open.'),
  start: z.number().int().min(1).describe('First page to read (1-indexed).'),
  end: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Last page to read (inclusive); omit for a single page.')
}
const pdfPagesToolDefinition = {
  title: 'Read PDF pages as text',
  description: PDF_PAGES_TOOL_DESCRIPTION,
  inputSchema: pdfPagesToolSchema
}

const pdfOutlineToolSchema = {
  doc_id: z.string().min(1).describe('Document id from pdf_open.')
}
const pdfOutlineToolDefinition = {
  title: 'List PDF table of contents',
  description: PDF_OUTLINE_TOOL_DESCRIPTION,
  inputSchema: pdfOutlineToolSchema
}

const pdfScanToolSchema = {
  doc_id: z.string().min(1).describe('Document id from pdf_open.'),
  query: z.string().min(1).max(200).describe('What to find — a dataset name, metric, or term.')
}
const pdfScanToolDefinition = {
  title: 'Scan PDF pages for relevance',
  description: PDF_SCAN_TOOL_DESCRIPTION,
  inputSchema: pdfScanToolSchema
}

export type PdfMcpEnvironment = {
  endpoint: string
  socketPath?: string
  token: string
  sessionId: string
  projectId: string
}

export type PdfRpcConnection = LocalRpcTransport & {
  token: string
  release?: () => void
}

type PdfMcpHandler = {
  open: (path: string) => Promise<PdfOpenResult>
  pages: (docId: string, start: number, end?: number) => Promise<PdfPagesResult>
  outline: (docId: string) => Promise<PdfOutlineResult>
  scan: (docId: string, query: string) => Promise<PdfScanResult>
}

type PdfMcpServerConfigRequest = PdfMcpEnvironment & {
  command: string
  entryPath: string
}

type RpcResponse = {
  result?: PdfOpenResult | PdfPagesResult | PdfOutlineResult | PdfScanResult
  error?: string
}

const createPdfMcpServer = (handler: PdfMcpHandler): ModelContextProtocolServer => {
  const server = new ModelContextProtocolServer({
    name: PDF_MCP_SERVER_NAME,
    version: '1.0.0'
  })

  server.registerTool(PDF_OPEN_TOOL_NAME, pdfOpenToolDefinition, async (input) => {
    const result = await handler.open(input.path)
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
    }
  })

  server.registerTool(PDF_PAGES_TOOL_NAME, pdfPagesToolDefinition, async (input) => {
    const result = await handler.pages(input.doc_id, input.start, input.end)
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
    }
  })

  server.registerTool(PDF_OUTLINE_TOOL_NAME, pdfOutlineToolDefinition, async (input) => {
    const result = await handler.outline(input.doc_id)
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
    }
  })

  server.registerTool(PDF_SCAN_TOOL_NAME, pdfScanToolDefinition, async (input) => {
    const result = await handler.scan(input.doc_id, input.query)
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
    }
  })

  return server
}

const createPdfMcpServerConfig = ({
  command,
  entryPath,
  endpoint,
  socketPath,
  token,
  sessionId,
  projectId
}: PdfMcpServerConfigRequest): McpServerStdio => ({
  name: PDF_MCP_SERVER_NAME,
  command,
  args: [entryPath, PDF_MCP_SERVER_ARG],
  env: [
    { name: 'ELECTRON_RUN_AS_NODE', value: '1' },
    { name: 'PURESCIENCE_PDF_RPC_ENDPOINT', value: endpoint },
    ...(socketPath
      ? [{ name: 'PURESCIENCE_PDF_RPC_SOCKET_PATH', value: socketPath }]
      : []),
    { name: 'PURESCIENCE_PDF_RPC_TOKEN', value: token },
    { name: 'PURESCIENCE_PDF_SESSION_ID', value: sessionId },
    { name: 'PURESCIENCE_PDF_PROJECT_ID', value: projectId }
  ]
})

const requireEnvironmentVariable = (env: NodeJS.ProcessEnv, name: string): string => {
  const value = env[name]
  if (!value) throw new Error(`Missing PDF MCP environment variable: ${name}`)
  return value
}

const createPdfMcpEnvironmentFromProcess = (
  env: NodeJS.ProcessEnv = process.env
): PdfMcpEnvironment => ({
  endpoint: requireEnvironmentVariable(env, 'PURESCIENCE_PDF_RPC_ENDPOINT'),
  socketPath: env.PURESCIENCE_PDF_RPC_SOCKET_PATH,
  token: requireEnvironmentVariable(env, 'PURESCIENCE_PDF_RPC_TOKEN'),
  sessionId: requireEnvironmentVariable(env, 'PURESCIENCE_PDF_SESSION_ID'),
  projectId: requireEnvironmentVariable(env, 'PURESCIENCE_PDF_PROJECT_ID')
})

const callPdfRpc = async (
  environment: PdfMcpEnvironment,
  method: string,
  params: Record<string, unknown>
): Promise<RpcResponse['result']> => {
  const response = await fetchLocalRpc(
    environment,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${environment.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        method,
        params: {
          sessionId: environment.sessionId,
          projectId: environment.projectId,
          ...params
        }
      })
    },
    `PDF ${method} RPC`
  )
  const payload = (await response.json()) as RpcResponse

  if (!response.ok || payload.error || !payload.result) {
    throw new Error(payload.error ?? `PDF ${method} RPC failed with status ${response.status}`)
  }
  return payload.result
}

const runPdfMcpServer = async (
  environment = createPdfMcpEnvironmentFromProcess()
): Promise<void> => {
  const server = createPdfMcpServer({
    open: (path) =>
      callPdfRpc(environment, 'pdfOpen', { path }) as Promise<PdfOpenResult>,
    pages: (docId, start, end) =>
      callPdfRpc(environment, 'pdfPages', {
        docId,
        start,
        ...(end !== undefined ? { end } : {})
      }) as Promise<PdfPagesResult>,
    outline: (docId) =>
      callPdfRpc(environment, 'pdfOutline', { docId }) as Promise<PdfOutlineResult>,
    scan: (docId, query) =>
      callPdfRpc(environment, 'pdfScan', { docId, query }) as Promise<PdfScanResult>
  })
  await server.connect(new StdioServerTransport())
}

export {
  PDF_MCP_SERVER_ARG,
  PDF_MCP_SERVER_NAME,
  PDF_OPEN_TOOL_NAME,
  PDF_PAGES_TOOL_NAME,
  PDF_OUTLINE_TOOL_NAME,
  PDF_SCAN_TOOL_NAME,
  pdfOpenToolDefinition,
  pdfPagesToolDefinition,
  pdfOutlineToolDefinition,
  pdfScanToolDefinition,
  createPdfMcpEnvironmentFromProcess,
  createPdfMcpServer,
  createPdfMcpServerConfig,
  runPdfMcpServer
}
export type { PdfMcpHandler }
