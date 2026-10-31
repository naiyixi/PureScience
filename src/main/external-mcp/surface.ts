// The external MCP surface: what an outside MCP client (a desktop assistant, a script) may ask this app
// for, and nothing else.
//
// Why a separate surface instead of re-exposing the Web RPC: `createWebCallerContext` labels its caller
// `human`, so an outside client driving those channels would be able to change data without ever crossing
// the permission gate, and the log could not say who approved what. This module is the *declaration*;
// `server.ts` owns transport and dispatch, and the command whitelist lives in
// `application-command-composition.ts` (`EXTERNAL_MCP_COMMAND_NAMES`) so the reachable set is one list.
//
// This slice declares four read tools and one write tool. The write tool is why the permission gate
// exists: `dispatchToolCall` asks the app's own approval card before it invokes anything for a
// `risk: 'write'` tool, and refuses (named, nothing changed) when that card cannot be answered. A further
// write tool needs its own argument for why an outside client holding no authority may perform it; the
// read tools need none because they change nothing.
//
// Everything in this file is pure data or a pure projection: no Electron, no filesystem, no clock. That is
// what lets the paired suite assert the registry, the schemas and the projections without a running app.

import type { PersistedChatSession } from '../../shared/session-persistence'

export type ExternalMcpToolId =
  'list_projects' | 'list_sessions' | 'read_session' | 'list_project_files' | 'archive_session'

// `read` touches nothing. `write` changes what the app holds, so it must pass the approval card first —
// the dispatch path branches on this value, and a write slipping into the read branch would perform an
// action nobody approved. Do not add a third level here without wiring it in `server.ts` first.
export type ExternalMcpToolRisk = 'read' | 'write'

// Plain JSON Schema (draft-07 subset) rather than a zod shape: the tool list is served verbatim through
// `tools/list`, so what a client sees is exactly what this table declares. Validation of the few
// arguments each tool takes is explicit in `server.ts`, where the refusal can name the missing field.
export type ExternalMcpInputSchema = Readonly<{
  type: 'object'
  properties?: Readonly<Record<string, Readonly<Record<string, unknown>>>>
  required?: readonly string[]
  additionalProperties: false
}>

export type ExternalMcpTool = Readonly<{
  id: ExternalMcpToolId
  title: string
  // Shown to the outside model. Agent-facing text, so it stays English like every other MCP description
  // in this repository (it is not user interface copy and is never localized).
  description: string
  inputSchema: ExternalMcpInputSchema
  risk: ExternalMcpToolRisk
  // The application command this tool delegates to. The composition certifies every one of these names is
  // in the external-MCP whitelist, so a tool cannot be declared against a command an outside client is not
  // actually allowed to reach.
  command: string
}>

const EXTERNAL_MCP_TOOLS: readonly ExternalMcpTool[] = Object.freeze([
  Object.freeze({
    id: 'list_projects' as const,
    title: 'List projects',
    description:
      'List the projects (libraries) on this machine, with each project id and name. Project ids are ' +
      'what list_sessions and the other read tools take.',
    inputSchema: Object.freeze({ type: 'object' as const, additionalProperties: false }),
    risk: 'read' as const,
    command: 'projects:list'
  }),
  Object.freeze({
    id: 'list_sessions' as const,
    title: 'List sessions',
    description:
      'List the conversations in this library as summaries: id, project, title, status, updated time and ' +
      'message count, plus `archived` (an ISO timestamp) on the ones that have been archived. Pass ' +
      '`project` (an id from list_projects, or an exact project name) to narrow it.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        project: Object.freeze({
          type: 'string',
          description: 'Project id or exact project name. Omit to list every project.'
        })
      }),
      additionalProperties: false as const
    }),
    risk: 'read' as const,
    command: 'sessions:list-catalog'
  }),
  Object.freeze({
    id: 'read_session' as const,
    title: 'Read a session',
    description:
      'Read one conversation: its title, status and messages. Long conversations are returned as the ' +
      'most recent `limit` messages (default 40) and the result states `truncated: true` together with ' +
      'the total `messageCount` — never assume the returned list is the whole conversation.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        sessionId: Object.freeze({ type: 'string', description: 'Session id from list_sessions' }),
        limit: Object.freeze({
          type: 'integer',
          minimum: 1,
          maximum: 200,
          description: 'How many of the most recent messages to return (default 40)'
        })
      }),
      required: Object.freeze(['sessionId']),
      additionalProperties: false as const
    }),
    risk: 'read' as const,
    command: 'sessions:read-document'
  }),
  Object.freeze({
    id: 'list_project_files' as const,
    title: 'List the files of a project',
    description:
      'List the artifacts and files the app holds for one project (id, kind, stored path, name, owning ' +
      'session when known). Pass `project`: a project id from list_projects, or its exact name.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        project: Object.freeze({
          type: 'string',
          description: 'Project id from list_projects, or its exact name'
        })
      }),
      required: Object.freeze(['project']),
      additionalProperties: false
    }),
    risk: 'read' as const,
    command: 'artifacts:list-project-files'
  }),
  Object.freeze({
    id: 'archive_session' as const,
    title: 'Archive a session',
    description:
      'Archive one conversation so it leaves the default list without being deleted; its messages are not ' +
      "erased. This changes what the app holds, so it is not performed on the client's word: the app asks " +
      'its own user to approve each call, and that card is shown in this conversation — which therefore has ' +
      'to be open in the app. When the app is also serving its web API, the card can be answered from a ' +
      'terminal instead (`purescience permissions`, then `purescience approve`). When no card can be shown, ' +
      'the call is refused and nothing changes.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        sessionId: Object.freeze({
          type: 'string',
          description: 'Session id from list_sessions (the conversation to archive)'
        })
      }),
      required: Object.freeze(['sessionId']),
      additionalProperties: false as const
    }),
    risk: 'write' as const,
    command: 'sessions:update-archive'
  })
])

const externalMcpToolIds: readonly ExternalMcpToolId[] = Object.freeze(
  EXTERNAL_MCP_TOOLS.map((tool) => tool.id)
)

// Every command the surface is allowed to reach, derived from the table rather than typed twice.
const externalMcpCommandNames: readonly string[] = Object.freeze(
  [...new Set(EXTERNAL_MCP_TOOLS.map((tool) => tool.command))].sort()
)

const externalMcpToolById = (id: string): ExternalMcpTool | undefined =>
  EXTERNAL_MCP_TOOLS.find((tool) => tool.id === id)

// ---- projections -------------------------------------------------------------------------------
// Pure functions over what the application commands already returned. Kept here (not inside the server)
// so the shape a client receives is asserted without a transport.

export type ExternalMcpProjectRow = Readonly<{
  id: string
  name: string
  description?: string
}>

export type ExternalMcpSessionRow = Readonly<{
  id: string
  projectId: string
  title: string
  status: string
  // ISO 8601, converted from the stored epoch milliseconds. Absent when the record has no timestamp —
  // a client must be able to tell "no timestamp" from "the epoch".
  updatedAt?: string
  // ISO 8601, present only while the conversation is archived. Without it an outside client could archive
  // a conversation and then list it again seeing no difference at all — a write whose effect its own author
  // cannot observe. Absent means "in the default list", which is the honest reading rather than a claim
  // that it was never archived.
  archived?: string
  messageCount: number
}>

export type ExternalMcpMessageRow = Readonly<{
  id: string
  role: string
  status: string
  content: string
}>

export type ExternalMcpSessionExcerpt = Readonly<{
  sessionId: string
  projectId: string
  title: string
  status: string
  cwd: string
  messageCount: number
  messagesReturned: number
  // Explicit either way: a client must not have to infer "no messages" from an empty array.
  truncated: boolean
  messages: readonly ExternalMcpMessageRow[]
}>

const DEFAULT_MESSAGE_LIMIT = 40
const MAX_MESSAGE_LIMIT = 200

const projectRow = (project: {
  id: string
  name: string
  description?: string
}): ExternalMcpProjectRow => {
  const row: ExternalMcpProjectRow = { id: project.id, name: project.name }
  return project.description === undefined ? row : { ...row, description: project.description }
}

const sessionRow = (session: {
  id: string
  projectId: string
  title: string
  status: string
  updatedAt?: number
  archivedAt?: number
  messageCount?: number
  messages?: readonly unknown[]
}): ExternalMcpSessionRow => {
  const row: ExternalMcpSessionRow = {
    id: session.id,
    projectId: session.projectId,
    title: session.title,
    status: session.status,
    messageCount: session.messageCount ?? session.messages?.length ?? 0
  }
  // The stored value is epoch milliseconds. An unusable value is reported as absent rather than as
  // `Invalid Date`, so a client never has to parse a string that is not a timestamp.
  const stamped = (value: number | undefined): string | undefined =>
    value === undefined || !Number.isFinite(value) ? undefined : new Date(value).toISOString()
  const updatedAt = stamped(session.updatedAt)
  const archived = stamped(session.archivedAt)
  return {
    ...row,
    ...(updatedAt === undefined ? {} : { updatedAt }),
    ...(archived === undefined ? {} : { archived })
  }
}

// The most recent messages, in conversation order. `limit` is clamped rather than rejected: a client
// asking for 10 000 messages gets the cap, and `truncated`/`messagesReturned` say so.
const sessionExcerpt = (
  session: PersistedChatSession,
  requestedLimit: number | undefined
): ExternalMcpSessionExcerpt => {
  const all = session.messages ?? []
  const limit = Math.min(
    MAX_MESSAGE_LIMIT,
    Math.max(1, Number.isFinite(requestedLimit) ? Number(requestedLimit) : DEFAULT_MESSAGE_LIMIT)
  )
  const recent = all.slice(Math.max(0, all.length - limit))
  return {
    sessionId: session.id,
    projectId: session.projectId,
    title: session.title,
    status: session.status,
    cwd: session.cwd,
    messageCount: all.length,
    messagesReturned: recent.length,
    truncated: recent.length < all.length,
    messages: recent.map((message) => ({
      id: message.id,
      role: message.role,
      status: message.status,
      content: message.content
    }))
  }
}

export {
  DEFAULT_MESSAGE_LIMIT,
  EXTERNAL_MCP_TOOLS,
  MAX_MESSAGE_LIMIT,
  externalMcpCommandNames,
  externalMcpToolById,
  externalMcpToolIds,
  projectRow,
  sessionExcerpt,
  sessionRow
}
