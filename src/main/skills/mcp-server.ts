import type { McpServerStdio } from '@agentclientprotocol/sdk'
import { McpServer as ModelContextProtocolServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

import type { ConversationSkillImportResult } from '../../shared/settings'
import {
  REQUEST_SKILL_IMPORT_TOOL_DESCRIPTION,
  REQUEST_SKILL_IMPORT_TOOL_NAME,
  SKILL_IMPORT_MCP_SERVER_NAME
} from '../../shared/skill-import'
import {
  SKILL_CREATE_MAX_DESCRIPTION_LENGTH,
  SKILL_CREATE_MAX_INSTRUCTIONS_LENGTH,
  SKILL_CREATE_MAX_NAME_LENGTH,
  SKILL_CREATE_MAX_REFERENCE_LENGTH,
  SKILL_CREATE_MAX_REFERENCES,
  SKILL_CREATE_MIN_NAME_LENGTH,
  SKILL_CREATE_SYSTEM_PROMPT_APPEND,
  SKILL_CREATE_TOOL_DESCRIPTION,
  SKILL_CREATE_TOOL_NAME,
  type SkillCreateInput,
  type SkillCreateResult
} from '../../shared/skill-create'
import { SkillCreator } from './skill-creator'
import { SKILL_IMPORT_MCP_SERVER_ARG } from '../mcp-server-args'
import { fetchLocalRpc, type LocalRpcTransport } from '../local-rpc-transport'
import { parseGitHubSkillUrl } from './github-import'

const requestSkillImportToolSchema = {
  attachment_uri: z
    .string()
    .url()
    .optional()
    .describe('Exact file URI of the attachment marked skillImportEligible in the user prompt.'),
  turn_token: z
    .string()
    .uuid()
    .optional()
    .describe('Exact skillImportTurnToken from the same eligible attachment reference.'),
  github_url: z
    .string()
    .url()
    .refine((url) => parseGitHubSkillUrl(url) !== null, 'Must be an HTTPS github.com Skill URL.')
    .optional()
    .describe('Exact public github.com URL of the Skill directory or its SKILL.md file.')
}
const requestSkillImportToolDefinition = {
  title: 'Request Skill import',
  description: REQUEST_SKILL_IMPORT_TOOL_DESCRIPTION,
  inputSchema: requestSkillImportToolSchema
}
const SKILL_IMPORT_SYSTEM_PROMPT_APPEND = [
  '<purescience_skill_import_instructions>',
  'When the user explicitly asks to install or import an attachment wrapped in <attached_skill_package> and marked skillImportEligible, call request_skill_import with its exact URI as attachment_uri and skillImportTurnToken as turn_token.',
  'When the user supplies an exact public github.com Skill directory or SKILL.md URL, call request_skill_import with that URL as github_url.',
  'When the user supplies only a Skill name or keywords, first use available web search to find its public github.com Skill directory or SKILL.md URL. Call request_skill_import only when one candidate is unambiguous; otherwise show the candidates and ask the user to choose.',
  'Do not download GitHub content into a temporary attachment. The application fetches the validated GitHub URL and owns preview, confirmation, and import.',
  'Do not invoke an external Skill installer, including skill-installer or install-skill-from-github.py, and do not write to codex/skills. Use request_skill_import so the application owns the import.',
  'The tool opens an application-owned preview and confirmation dialog. Never unpack or copy a Skill into a Skill directory yourself.',
  'An <attached_local_archive> is an ordinary ZIP reference, not an eligible Skill package. Do not call request_skill_import for it.',
  'A newly imported Skill becomes available on the next user turn after the agent runtime reloads.',
  '</purescience_skill_import_instructions>'
].join('\n')

type SkillImportRpcConnection = LocalRpcTransport & {
  token: string
  release?: () => void
}

type SkillImportMcpEnvironment = SkillImportRpcConnection & {
  sessionId: string
}

type SkillImportMcpHandler = {
  requestImport: (
    attachmentUri: string,
    turnToken: string
  ) => Promise<ConversationSkillImportResult>
  requestGitHubImport: (githubUrl: string) => Promise<ConversationSkillImportResult>
  createSkill: (input: SkillCreateInput) => Promise<SkillCreateResult>
}

type SkillImportMcpServerConfigRequest = SkillImportMcpEnvironment & {
  command: string
  entryPath: string
  // Framework config root containing `skills/`; lets the app-owned SkillCreator write drafts
  // directly (the MCP child runs as ELECTRON_RUN_AS_NODE with local filesystem access).
  configDir: string
}

type RpcResponse = {
  result?: ConversationSkillImportResult | SkillCreateResult
  error?: string
}

type SkillImportRpcParams = { attachmentUri: string; turnToken: string } | { githubUrl: string }

const createSkillImportMcpServer = (handler: SkillImportMcpHandler): ModelContextProtocolServer => {
  const server = new ModelContextProtocolServer({
    name: SKILL_IMPORT_MCP_SERVER_NAME,
    version: '1.0.0'
  })

  server.registerTool(
    REQUEST_SKILL_IMPORT_TOOL_NAME,
    requestSkillImportToolDefinition,
    async ({ attachment_uri, turn_token, github_url }) => {
      if (github_url && (attachment_uri || turn_token)) {
        throw new Error('Skill import accepts exactly one source.')
      }
      if (!github_url && (!attachment_uri || !turn_token)) {
        throw new Error(
          'Skill import requires either github_url or both attachment_uri and turn_token.'
        )
      }
      const result = github_url
        ? await handler.requestGitHubImport(github_url)
        : await handler.requestImport(attachment_uri!, turn_token!)
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
      }
    }
  )

  server.registerTool(
    SKILL_CREATE_TOOL_NAME,
    {
      title: 'Create a skill',
      description: SKILL_CREATE_TOOL_DESCRIPTION,
      inputSchema: {
        name: z
          .string()
          .min(SKILL_CREATE_MIN_NAME_LENGTH)
          .max(SKILL_CREATE_MAX_NAME_LENGTH)
          .regex(/^[a-z0-9_-]+$/, 'Lowercase letters, digits, hyphens, underscores.')
          .describe('Skill name.'),
        description: z
          .string()
          .max(SKILL_CREATE_MAX_DESCRIPTION_LENGTH)
          .describe('One-line description of what the skill does.'),
        instructions: z
          .string()
          .max(SKILL_CREATE_MAX_INSTRUCTIONS_LENGTH)
          .describe('Step-by-step markdown instructions for the skill.'),
        references: z
          .array(z.string().max(SKILL_CREATE_MAX_REFERENCE_LENGTH))
          .max(SKILL_CREATE_MAX_REFERENCES)
          .optional()
          .describe('Optional reference URLs or file paths the skill depends on.')
      }
    },
    async (input: SkillCreateInput) => {
      const result = await handler.createSkill(input)
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
      }
    }
  )

  return server
}

const createSkillImportMcpServerConfig = ({
  command,
  entryPath,
  endpoint,
  socketPath,
  token,
  sessionId,
  configDir
}: SkillImportMcpServerConfigRequest): McpServerStdio => ({
  name: SKILL_IMPORT_MCP_SERVER_NAME,
  command,
  args: [entryPath, SKILL_IMPORT_MCP_SERVER_ARG],
  env: [
    { name: 'ELECTRON_RUN_AS_NODE', value: '1' },
    { name: 'PURESCIENCE_SKILL_IMPORT_RPC_ENDPOINT', value: endpoint },
    ...(socketPath
      ? [{ name: 'PURESCIENCE_SKILL_IMPORT_RPC_SOCKET_PATH', value: socketPath }]
      : []),
    { name: 'PURESCIENCE_SKILL_IMPORT_RPC_TOKEN', value: token },
    { name: 'PURESCIENCE_SKILL_IMPORT_SESSION_ID', value: sessionId },
    { name: 'PURESCIENCE_SKILLS_CONFIG_DIR', value: configDir }
  ]
})

const requireEnvironmentVariable = (env: NodeJS.ProcessEnv, name: string): string => {
  const value = env[name]
  if (!value) throw new Error(`Missing Skill import MCP environment variable: ${name}`)
  return value
}

const createSkillImportMcpEnvironmentFromProcess = (
  env: NodeJS.ProcessEnv = process.env
): SkillImportMcpEnvironment => ({
  endpoint: requireEnvironmentVariable(env, 'PURESCIENCE_SKILL_IMPORT_RPC_ENDPOINT'),
  socketPath: env.PURESCIENCE_SKILL_IMPORT_RPC_SOCKET_PATH,
  token: requireEnvironmentVariable(env, 'PURESCIENCE_SKILL_IMPORT_RPC_TOKEN'),
  sessionId: requireEnvironmentVariable(env, 'PURESCIENCE_SKILL_IMPORT_SESSION_ID')
})

const callSkillImportRpcRequest = async <T>(
  environment: SkillImportMcpEnvironment,
  params: SkillImportRpcParams
): Promise<T> => {
  const response = await fetchLocalRpc(
    environment,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${environment.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        method: 'skillImport',
        params: { sessionId: environment.sessionId, ...params }
      })
    },
    'Skill import RPC'
  )
  const payload = (await response.json()) as RpcResponse

  if (!response.ok || payload.error || !payload.result) {
    throw new Error(payload.error ?? `Skill import RPC failed with status ${response.status}`)
  }
  return payload.result as T
}

const callSkillImportRpc = (
  environment: SkillImportMcpEnvironment,
  attachmentUri: string,
  turnToken: string
): Promise<ConversationSkillImportResult> =>
  callSkillImportRpcRequest(environment, { attachmentUri, turnToken })

const callGitHubSkillImportRpc = (
  environment: SkillImportMcpEnvironment,
  githubUrl: string
): Promise<ConversationSkillImportResult> => callSkillImportRpcRequest(environment, { githubUrl })

// create_skill routes back into the main process the same way the import tools do, so the MCP
// child never touches the skills directory itself over the HTTP-hosted transport.
const callSkillCreateRpc = (
  environment: SkillImportMcpEnvironment,
  input: SkillCreateInput
): Promise<SkillCreateResult> =>
  fetchLocalRpc(
    environment,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${environment.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        method: 'skillCreate',
        params: { sessionId: environment.sessionId, ...input }
      })
    },
    'Skill create RPC'
  ).then(async (response) => {
    const payload = (await response.json()) as RpcResponse

    if (!response.ok || payload.error || !payload.result) {
      throw new Error(payload.error ?? `Skill create RPC failed with status ${response.status}`)
    }
    return payload.result as SkillCreateResult
  })

const runSkillImportMcpServer = async (
  environment = createSkillImportMcpEnvironmentFromProcess()
): Promise<void> => {
  const configDir = process.env['PURESCIENCE_SKILLS_CONFIG_DIR'] ?? ''
  const server = createSkillImportMcpServer({
    requestImport: (attachmentUri, turnToken) =>
      callSkillImportRpc(environment, attachmentUri, turnToken),
    requestGitHubImport: (githubUrl) => callGitHubSkillImportRpc(environment, githubUrl),
    createSkill: (input) => new SkillCreator({ configDir }).create(input)
  })
  await server.connect(new StdioServerTransport())
}

export {
  REQUEST_SKILL_IMPORT_TOOL_NAME,
  REQUEST_SKILL_IMPORT_TOOL_DESCRIPTION,
  SKILL_CREATE_TOOL_NAME,
  SKILL_IMPORT_MCP_SERVER_ARG,
  SKILL_IMPORT_MCP_SERVER_NAME,
  SKILL_IMPORT_SYSTEM_PROMPT_APPEND,
  SKILL_CREATE_SYSTEM_PROMPT_APPEND,
  callGitHubSkillImportRpc,
  callSkillCreateRpc,
  callSkillImportRpc,
  createSkillImportMcpEnvironmentFromProcess,
  createSkillImportMcpServer,
  createSkillImportMcpServerConfig,
  requestSkillImportToolDefinition,
  requestSkillImportToolSchema,
  runSkillImportMcpServer
}
export type {
  SkillImportMcpEnvironment,
  SkillImportMcpHandler,
  SkillImportMcpServerConfigRequest,
  SkillImportRpcConnection
}
