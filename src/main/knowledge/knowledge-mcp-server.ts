// Agent-facing knowledge-store MCP server: register a source (knowledge_register_source), list what is
// registered (knowledge_list_sources), and search those sources with citations (knowledge_search). The MCP
// process is a stdio child of the agent; the store, its fingerprints and the citation verifier live in the main
// process behind the app's local RPC gateway, so there is exactly one writer of `knowledge/sources.json`.

import type { McpServerStdio } from '@agentclientprotocol/sdk'
import { McpServer as ModelContextProtocolServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

import {
  KNOWLEDGE_LIST_SOURCES_TOOL_DESCRIPTION,
  KNOWLEDGE_LIST_SOURCES_TOOL_NAME,
  KNOWLEDGE_MCP_SERVER_NAME,
  KNOWLEDGE_REGISTER_SOURCE_TOOL_DESCRIPTION,
  KNOWLEDGE_REGISTER_SOURCE_TOOL_NAME,
  KNOWLEDGE_REMOVE_SOURCE_TOOL_DESCRIPTION,
  KNOWLEDGE_REMOVE_SOURCE_TOOL_NAME,
  KNOWLEDGE_RENDER_WIKI_TOOL_DESCRIPTION,
  KNOWLEDGE_RENDER_WIKI_TOOL_NAME,
  KNOWLEDGE_SEARCH_RESULT_LIMIT,
  KNOWLEDGE_SEARCH_TOOL_DESCRIPTION,
  KNOWLEDGE_SEARCH_TOOL_NAME
} from '../../shared/knowledge-mcp'
import type {
  KnowledgeOverview,
  KnowledgeRegistration,
  KnowledgeSearchResponse,
  KnowledgeSource
} from '../../shared/knowledge'
import type { KnowledgeWikiResult } from './knowledge-wiki'
import { fetchLocalRpc, type LocalRpcTransport } from '../local-rpc-transport'
import { KNOWLEDGE_MCP_SERVER_ARG } from '../mcp-server-args'

const knowledgeSearchToolSchema = {
  query: z
    .string()
    .min(1)
    .max(500)
    .describe(
      'What to find. Every whitespace-separated term must appear on the same line (or in the same fetched document for a URL source).'
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(KNOWLEDGE_SEARCH_RESULT_LIMIT)
    .optional()
    .describe(`Maximum results to return (default and ceiling: ${KNOWLEDGE_SEARCH_RESULT_LIMIT}).`)
}

const knowledgeSearchToolDefinition = {
  title: 'Search registered knowledge sources with citations',
  description: KNOWLEDGE_SEARCH_TOOL_DESCRIPTION,
  inputSchema: knowledgeSearchToolSchema
}

const knowledgeRegisterSourceToolSchema = {
  kind: z
    .enum(['file', 'folder', 'url'])
    .describe('file = one local file; folder = every file in a local tree; url = one web page.'),
  path: z
    .string()
    .min(1)
    .max(4096)
    .optional()
    .describe(
      'Absolute local path. Required for kind "file" and "folder"; must sit inside a managed root.'
    ),
  url: z
    .string()
    .min(1)
    .max(4096)
    .optional()
    .describe(
      'Absolute http(s) URL. Required for kind "url"; the request is followed to its final address.'
    )
}

const knowledgeRegisterSourceToolDefinition = {
  title: 'Register a file, folder, or URL as a knowledge source',
  description: KNOWLEDGE_REGISTER_SOURCE_TOOL_DESCRIPTION,
  inputSchema: knowledgeRegisterSourceToolSchema
}

const knowledgeRenderWikiToolSchema = {
  folder: z
    .string()
    .min(1)
    .max(4096)
    .describe('Absolute path of a folder that was registered with kind "folder".')
}

const knowledgeRenderWikiToolDefinition = {
  title: 'Render a deterministic wiki for a registered folder',
  description: KNOWLEDGE_RENDER_WIKI_TOOL_DESCRIPTION,
  inputSchema: knowledgeRenderWikiToolSchema
}

const knowledgeRemoveSourceToolSchema = {
  source_id: z.string().min(1).describe('Source id from knowledge_list_sources.')
}

const knowledgeRemoveSourceToolDefinition = {
  title: 'Remove a registered knowledge source',
  description: KNOWLEDGE_REMOVE_SOURCE_TOOL_DESCRIPTION,
  inputSchema: knowledgeRemoveSourceToolSchema
}

const knowledgeListSourcesToolDefinition = {
  title: 'List the registered knowledge sources',
  description: KNOWLEDGE_LIST_SOURCES_TOOL_DESCRIPTION,
  inputSchema: {}
}

export type KnowledgeMcpEnvironment = {
  endpoint: string
  socketPath?: string
  token: string
  sessionId: string
  projectId: string
}

export type KnowledgeRpcConnection = LocalRpcTransport & {
  token: string
  release?: () => void
}

export type KnowledgeMcpHandler = {
  search: (query: string, limit?: number) => Promise<KnowledgeSearchResponse>
  registerSource: (request: KnowledgeRegistration) => Promise<KnowledgeSource[]>
  listSources: () => Promise<KnowledgeOverview>
  renderWiki: (folder: string) => Promise<KnowledgeWikiResult>
  removeSource: (
    sourceId: string
  ) => Promise<{ removed: KnowledgeSource; prunedContents: string[] }>
}

type KnowledgeMcpServerConfigRequest = KnowledgeMcpEnvironment & {
  command: string
  entryPath: string
}

type RpcResponse = {
  result?:
    | KnowledgeSearchResponse
    | KnowledgeSource[]
    | KnowledgeOverview
    | KnowledgeWikiResult
    | { removed: KnowledgeSource; prunedContents: string[] }
  error?: string
}

const asText = (result: unknown): { content: { type: 'text'; text: string }[] } => ({
  content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
})

const createKnowledgeMcpServer = (handler: KnowledgeMcpHandler): ModelContextProtocolServer => {
  const server = new ModelContextProtocolServer({
    name: KNOWLEDGE_MCP_SERVER_NAME,
    version: '1.0.0'
  })

  server.registerTool(KNOWLEDGE_SEARCH_TOOL_NAME, knowledgeSearchToolDefinition, async (input) =>
    asText(await handler.search(input.query, input.limit))
  )

  server.registerTool(
    KNOWLEDGE_REGISTER_SOURCE_TOOL_NAME,
    knowledgeRegisterSourceToolDefinition,
    async (input) => asText(await handler.registerSource(registrationFrom(input)))
  )

  server.registerTool(
    KNOWLEDGE_LIST_SOURCES_TOOL_NAME,
    knowledgeListSourcesToolDefinition,
    async () => asText(await handler.listSources())
  )

  server.registerTool(
    KNOWLEDGE_REMOVE_SOURCE_TOOL_NAME,
    knowledgeRemoveSourceToolDefinition,
    async (input) => asText(await handler.removeSource(input.source_id))
  )

  server.registerTool(
    KNOWLEDGE_RENDER_WIKI_TOOL_NAME,
    knowledgeRenderWikiToolDefinition,
    async (input) => asText(await handler.renderWiki(input.folder))
  )

  return server
}

// The tool accepts path and url side by side with a kind; the store takes a discriminated request. The mismatch
// is refused HERE, with the reason, rather than sent to the main process to guess at.
const registrationFrom = (input: {
  kind: 'file' | 'folder' | 'url'
  path?: string
  url?: string
}): KnowledgeRegistration => {
  if (input.kind === 'url') {
    if (!input.url) throw new Error('kind "url" requires a url.')
    return { kind: 'url', url: input.url }
  }
  if (!input.path) throw new Error(`kind "${input.kind}" requires a path.`)
  return input.kind === 'file'
    ? { kind: 'file', path: input.path }
    : { kind: 'folder', path: input.path }
}

const createKnowledgeMcpServerConfig = ({
  command,
  entryPath,
  endpoint,
  socketPath,
  token,
  sessionId,
  projectId
}: KnowledgeMcpServerConfigRequest): McpServerStdio => ({
  name: KNOWLEDGE_MCP_SERVER_NAME,
  command,
  args: [entryPath, KNOWLEDGE_MCP_SERVER_ARG],
  env: [
    { name: 'ELECTRON_RUN_AS_NODE', value: '1' },
    { name: 'PURESCIENCE_KNOWLEDGE_RPC_ENDPOINT', value: endpoint },
    ...(socketPath ? [{ name: 'PURESCIENCE_KNOWLEDGE_RPC_SOCKET_PATH', value: socketPath }] : []),
    { name: 'PURESCIENCE_KNOWLEDGE_RPC_TOKEN', value: token },
    { name: 'PURESCIENCE_KNOWLEDGE_SESSION_ID', value: sessionId },
    { name: 'PURESCIENCE_KNOWLEDGE_PROJECT_ID', value: projectId }
  ]
})

const requireEnvironmentVariable = (env: NodeJS.ProcessEnv, name: string): string => {
  const value = env[name]
  if (!value) throw new Error(`Missing knowledge MCP environment variable: ${name}`)
  return value
}

const createKnowledgeMcpEnvironmentFromProcess = (
  env: NodeJS.ProcessEnv = process.env
): KnowledgeMcpEnvironment => ({
  endpoint: requireEnvironmentVariable(env, 'PURESCIENCE_KNOWLEDGE_RPC_ENDPOINT'),
  socketPath: env.PURESCIENCE_KNOWLEDGE_RPC_SOCKET_PATH,
  token: requireEnvironmentVariable(env, 'PURESCIENCE_KNOWLEDGE_RPC_TOKEN'),
  sessionId: requireEnvironmentVariable(env, 'PURESCIENCE_KNOWLEDGE_SESSION_ID'),
  projectId: requireEnvironmentVariable(env, 'PURESCIENCE_KNOWLEDGE_PROJECT_ID')
})

const callKnowledgeRpc = async (
  environment: KnowledgeMcpEnvironment,
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
    `Knowledge ${method} RPC`
  )
  const payload = (await response.json()) as RpcResponse

  if (!response.ok || payload.error || !payload.result) {
    throw new Error(
      payload.error ?? `Knowledge ${method} RPC failed with status ${response.status}`
    )
  }
  return payload.result
}

const runKnowledgeMcpServer = async (
  environment = createKnowledgeMcpEnvironmentFromProcess()
): Promise<void> => {
  const server = createKnowledgeMcpServer({
    search: (query, limit) =>
      callKnowledgeRpc(environment, 'knowledgeSearch', {
        text: query,
        ...(limit !== undefined ? { limit } : {})
      }) as Promise<KnowledgeSearchResponse>,
    registerSource: (request) =>
      callKnowledgeRpc(environment, 'knowledgeRegisterSource', { request }) as Promise<
        KnowledgeSource[]
      >,
    listSources: () =>
      callKnowledgeRpc(environment, 'knowledgeListSources', {}) as Promise<KnowledgeOverview>,
    removeSource: (sourceId) =>
      callKnowledgeRpc(environment, 'knowledgeRemoveSource', { sourceId }) as Promise<{
        removed: KnowledgeSource
        prunedContents: string[]
      }>,
    renderWiki: (folder) =>
      callKnowledgeRpc(environment, 'knowledgeRenderWiki', {
        folder
      }) as Promise<KnowledgeWikiResult>
  })
  await server.connect(new StdioServerTransport())
}

export {
  KNOWLEDGE_MCP_SERVER_ARG,
  KNOWLEDGE_MCP_SERVER_NAME,
  KNOWLEDGE_SEARCH_TOOL_NAME,
  KNOWLEDGE_REGISTER_SOURCE_TOOL_NAME,
  KNOWLEDGE_LIST_SOURCES_TOOL_NAME,
  KNOWLEDGE_REMOVE_SOURCE_TOOL_NAME,
  KNOWLEDGE_RENDER_WIKI_TOOL_NAME,
  knowledgeRemoveSourceToolDefinition,
  knowledgeSearchToolDefinition,
  knowledgeRenderWikiToolDefinition,
  knowledgeRegisterSourceToolDefinition,
  knowledgeListSourcesToolDefinition,
  registrationFrom,
  createKnowledgeMcpEnvironmentFromProcess,
  createKnowledgeMcpServer,
  createKnowledgeMcpServerConfig,
  runKnowledgeMcpServer
}
