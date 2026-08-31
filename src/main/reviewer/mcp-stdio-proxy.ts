import type { McpServerStdio } from '@agentclientprotocol/sdk'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

import { REVIEWER_MCP_SERVER_NAME } from '../../shared/reviewer'
import { fetchOverSocket } from '../local-rpc-transport'
import { REVIEWER_MCP_PROXY_ARG } from '../mcp-server-args'

type ReviewerMcpProxyEnvironment = {
  socketPath: string
  token: string
}

type ReviewerMcpProxyConfigRequest = ReviewerMcpProxyEnvironment & {
  command: string
  entryPath: string
}

const requireEnvironmentVariable = (env: NodeJS.ProcessEnv, name: string): string => {
  const value = env[name]
  if (!value) throw new Error(`Missing Reviewer MCP proxy environment variable: ${name}`)
  return value
}

const createReviewerMcpProxyEnvironmentFromProcess = (
  env: NodeJS.ProcessEnv = process.env
): ReviewerMcpProxyEnvironment => ({
  socketPath: requireEnvironmentVariable(env, 'PURESCIENCE_REVIEWER_MCP_SOCKET_PATH'),
  token: requireEnvironmentVariable(env, 'PURESCIENCE_REVIEWER_MCP_TOKEN')
})

const createReviewerMcpStdioProxyConfig = ({
  command,
  entryPath,
  socketPath,
  token
}: ReviewerMcpProxyConfigRequest): McpServerStdio => ({
  name: REVIEWER_MCP_SERVER_NAME,
  command,
  args: [entryPath, REVIEWER_MCP_PROXY_ARG],
  env: [
    { name: 'ELECTRON_RUN_AS_NODE', value: '1' },
    { name: 'PURESCIENCE_REVIEWER_MCP_SOCKET_PATH', value: socketPath },
    { name: 'PURESCIENCE_REVIEWER_MCP_TOKEN', value: token }
  ]
})

// Presents the existing scope-enforcing Reviewer MCP server as stdio while moving only its local
// transport over a Windows named pipe. Tool definitions, validation, and submission remain source.
const createReviewerMcpStdioProxy = async (
  environment = createReviewerMcpProxyEnvironmentFromProcess()
): Promise<Server> => {
  const source = new Client({ name: 'purescience-reviewer-proxy', version: '1.0.0' })
  await source.connect(
    new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
      fetch: fetchOverSocket(environment.socketPath),
      requestInit: { headers: { authorization: `Bearer ${environment.token}` } }
    })
  )

  const downstream = new Server(
    { name: REVIEWER_MCP_SERVER_NAME, version: '1.0.0' },
    { capabilities: { tools: {} } }
  )
  downstream.setRequestHandler(ListToolsRequestSchema, (request) =>
    source.listTools(request.params)
  )
  downstream.setRequestHandler(CallToolRequestSchema, (request) => source.callTool(request.params))
  downstream.onclose = () => void source.close()

  return downstream
}

const runReviewerMcpStdioProxy = async (
  environment = createReviewerMcpProxyEnvironmentFromProcess()
): Promise<void> => {
  const downstream = await createReviewerMcpStdioProxy(environment)
  await downstream.connect(new StdioServerTransport())
}

export {
  createReviewerMcpProxyEnvironmentFromProcess,
  createReviewerMcpStdioProxy,
  createReviewerMcpStdioProxyConfig,
  runReviewerMcpStdioProxy
}
export type { ReviewerMcpProxyEnvironment }
