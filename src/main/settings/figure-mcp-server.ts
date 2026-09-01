// Agent-facing figure-review MCP server: reviews scientific figures against the
// publication-grade correctness checklist (figure_review). The MCP process runs as a stdio
// child of the agent; the rule engine lives in the main process over the app's local RPC
// gateway (same pattern as annotations/pdf).

import type { McpServerStdio } from '@agentclientprotocol/sdk'
import { McpServer as ModelContextProtocolServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

import {
  FIGURE_MCP_SERVER_NAME,
  FIGURE_REVIEW_TOOL_DESCRIPTION,
  FIGURE_REVIEW_TOOL_NAME
} from '../../shared/figure'
import type { FigurePanel, FigureReviewRequest, FigureReviewResult } from '../../shared/figure'
import { fetchLocalRpc, type LocalRpcTransport } from '../local-rpc-transport'
import { FIGURE_MCP_SERVER_ARG } from '../mcp-server-args'

const figurePanelSchema = z.object({
  id: z.string().min(1).describe('Panel id (e.g. "A", "B", "a").'),
  title: z.string().optional().describe('Short panel title.'),
  chart_type: z
    .enum(['line', 'bar', 'scatter', 'histogram', 'box', 'heatmap', 'other'])
    .describe('Chart type used in this panel.'),
  data_shape: z
    .object({
      time_series: z.boolean().optional().describe('True when the x-axis is time/ordered.'),
      categorical: z.boolean().optional().describe('True when comparing categories.'),
      distribution: z.boolean().optional().describe('True when showing a distribution.'),
      relationship: z.boolean().optional().describe('True when showing a two-variable relationship.')
    })
    .default({})
    .describe('Data shape hints for the chart-by-shape check.'),
  series_count: z.number().int().optional().describe('Distinct series/conditions drawn.'),
  label_count: z.number().int().optional().describe('Axis/legend labels shown.'),
  excluded_rows: z.number().int().optional().describe('Rows excluded from this panel.'),
  summary_used_excluded: z
    .boolean()
    .optional()
    .describe('True when summary stats still included the excluded rows.'),
  rendered: z.boolean().optional().describe('True once rendered and visually inspected.'),
  note: z.string().optional().describe('Free-form note (log scale, n per group, …).')
})

const figureReviewToolSchema = {
  figure_note: z.string().optional().describe('Optional figure-level note (figure number, context).'),
  panels: z.array(figurePanelSchema).min(1).describe('The panels of the figure to review.')
}
const figureReviewToolDefinition = {
  title: 'Review a figure for publication-grade correctness',
  description: FIGURE_REVIEW_TOOL_DESCRIPTION,
  inputSchema: figureReviewToolSchema
}

export type FigureMcpEnvironment = {
  endpoint: string
  socketPath?: string
  token: string
  sessionId: string
  projectId: string
}

export type FigureRpcConnection = LocalRpcTransport & {
  token: string
  release?: () => void
}

type FigureMcpHandler = {
  review: (request: FigureReviewRequest) => Promise<FigureReviewResult>
}

type FigureMcpServerConfigRequest = FigureMcpEnvironment & {
  command: string
  entryPath: string
}

type RpcResponse = {
  result?: FigureReviewResult
  error?: string
}

const createFigureMcpServer = (handler: FigureMcpHandler): ModelContextProtocolServer => {
  const server = new ModelContextProtocolServer({
    name: FIGURE_MCP_SERVER_NAME,
    version: '1.0.0'
  })

  server.registerTool(FIGURE_REVIEW_TOOL_NAME, figureReviewToolDefinition, async (input) => {
    const panels: FigurePanel[] = (input.panels as unknown[]).map((raw) => {
      const panel = raw as Record<string, unknown>
      const shape = (panel.data_shape ?? {}) as Record<string, unknown>
      return {
        id: String(panel.id),
        title: typeof panel.title === 'string' ? panel.title : undefined,
        chartType: panel.chart_type as FigurePanel['chartType'],
        dataShape: {
          timeSeries: shape.time_series === true ? true : undefined,
          categorical: shape.categorical === true ? true : undefined,
          distribution: shape.distribution === true ? true : undefined,
          relationship: shape.relationship === true ? true : undefined
        },
        seriesCount: typeof panel.series_count === 'number' ? panel.series_count : undefined,
        labelCount: typeof panel.label_count === 'number' ? panel.label_count : undefined,
        excludedRows: typeof panel.excluded_rows === 'number' ? panel.excluded_rows : undefined,
        summaryUsedExcluded:
          typeof panel.summary_used_excluded === 'boolean' ? panel.summary_used_excluded : undefined,
        rendered: typeof panel.rendered === 'boolean' ? panel.rendered : undefined,
        note: typeof panel.note === 'string' ? panel.note : undefined
      }
    })
    const result = await handler.review({
      figureNote: typeof input.figure_note === 'string' ? input.figure_note : undefined,
      panels
    })
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
    }
  })

  return server
}

const createFigureMcpServerConfig = ({
  command,
  entryPath,
  endpoint,
  socketPath,
  token,
  sessionId,
  projectId
}: FigureMcpServerConfigRequest): McpServerStdio => ({
  name: FIGURE_MCP_SERVER_NAME,
  command,
  args: [entryPath, FIGURE_MCP_SERVER_ARG],
  env: [
    { name: 'ELECTRON_RUN_AS_NODE', value: '1' },
    { name: 'PURESCIENCE_FIGURE_RPC_ENDPOINT', value: endpoint },
    ...(socketPath
      ? [{ name: 'PURESCIENCE_FIGURE_RPC_SOCKET_PATH', value: socketPath }]
      : []),
    { name: 'PURESCIENCE_FIGURE_RPC_TOKEN', value: token },
    { name: 'PURESCIENCE_FIGURE_SESSION_ID', value: sessionId },
    { name: 'PURESCIENCE_FIGURE_PROJECT_ID', value: projectId }
  ]
})

const requireEnvironmentVariable = (env: NodeJS.ProcessEnv, name: string): string => {
  const value = env[name]
  if (!value) throw new Error(`Missing figure MCP environment variable: ${name}`)
  return value
}

const createFigureMcpEnvironmentFromProcess = (
  env: NodeJS.ProcessEnv = process.env
): FigureMcpEnvironment => ({
  endpoint: requireEnvironmentVariable(env, 'PURESCIENCE_FIGURE_RPC_ENDPOINT'),
  socketPath: env.PURESCIENCE_FIGURE_RPC_SOCKET_PATH,
  token: requireEnvironmentVariable(env, 'PURESCIENCE_FIGURE_RPC_TOKEN'),
  sessionId: requireEnvironmentVariable(env, 'PURESCIENCE_FIGURE_SESSION_ID'),
  projectId: requireEnvironmentVariable(env, 'PURESCIENCE_FIGURE_PROJECT_ID')
})

const callFigureRpc = async (
  environment: FigureMcpEnvironment,
  params: Record<string, unknown>
): Promise<FigureReviewResult> => {
  const response = await fetchLocalRpc(
    environment,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${environment.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        method: 'figureReview',
        params: {
          sessionId: environment.sessionId,
          projectId: environment.projectId,
          ...params
        }
      })
    },
    'figureReview RPC'
  )
  const payload = (await response.json()) as RpcResponse

  if (!response.ok || payload.error || !payload.result) {
    throw new Error(payload.error ?? `figureReview RPC failed with status ${response.status}`)
  }
  return payload.result
}

const runFigureMcpServer = async (
  environment = createFigureMcpEnvironmentFromProcess()
): Promise<void> => {
  const server = createFigureMcpServer({
    review: (request) => callFigureRpc(environment, { ...request })
  })
  await server.connect(new StdioServerTransport())
}

export {
  FIGURE_MCP_SERVER_ARG,
  FIGURE_MCP_SERVER_NAME,
  FIGURE_REVIEW_TOOL_NAME,
  figureReviewToolDefinition,
  createFigureMcpEnvironmentFromProcess,
  createFigureMcpServer,
  createFigureMcpServerConfig,
  runFigureMcpServer
}
export type { FigureMcpHandler }
