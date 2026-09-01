// Annotation MCP server unit tests: contract surface (server name/arg/env wiring) and tool
// identity, mirroring the endpoint MCP server test style.

import { describe, expect, it, vi } from 'vitest'

import {
  ANNOTATION_LIST_TOOL_NAME,
  ANNOTATION_MCP_SERVER_ARG,
  ANNOTATION_MCP_SERVER_NAME,
  ANNOTATION_REMOVE_TOOL_NAME,
  ANNOTATION_SET_TOOL_NAME,
  createAnnotationMcpServer,
  createAnnotationMcpServerConfig
} from './annotation-mcp-server'
import type { FileAnnotation } from '../../shared/annotation'

const makeAnnotation = (overrides: Partial<FileAnnotation> = {}): FileAnnotation => ({
  id: 'ann-1',
  projectId: 'project-1',
  targetKind: 'file',
  targetKey: 'src/main.ts',
  label: 'todo',
  contentChecksum: null,
  note: 'Refactor the parsing loop.',
  createdBy: 'agent',
  createdAt: 1_000_000,
  updatedAt: 1_000_000,
  ...overrides
})

const makeHandler = () => ({
  set: vi.fn(async () => ({ annotation: makeAnnotation(), replaced: false })),
  list: vi.fn(async () => ({ annotations: [makeAnnotation()] })),
  remove: vi.fn(async () => ({ removed: true }))
})

describe('annotation MCP server contract', () => {
  it('names the server and the three tools', () => {
    expect(ANNOTATION_MCP_SERVER_NAME).toBe('purescience-annotations')
    expect(ANNOTATION_MCP_SERVER_ARG).toBe('--purescience-annotation-mcp')
    expect(ANNOTATION_SET_TOOL_NAME).toBe('annotation_set')
    expect(ANNOTATION_LIST_TOOL_NAME).toBe('annotation_list')
    expect(ANNOTATION_REMOVE_TOOL_NAME).toBe('annotation_remove')
  })

  it('registers the tools with their handler wiring', () => {
    const handler = makeHandler()
    const server = createAnnotationMcpServer(handler)
    const tools = (server as unknown as { _registeredTools: Record<string, unknown> })
      ._registeredTools
    expect(Object.keys(tools)).toHaveLength(3)
    expect(handler.set).not.toHaveBeenCalled()
  })

  it('builds a stdio server config with the annotation env', () => {
    const config = createAnnotationMcpServerConfig({
      command: '/usr/local/bin/purescience',
      entryPath: '/app/out/main/index.js',
      endpoint: 'http://127.0.0.1:8642',
      token: 'tok-123',
      sessionId: 'session-9',
      projectId: 'project-1'
    })
    expect(config.name).toBe('purescience-annotations')
    expect(config.args).toEqual(['/app/out/main/index.js', '--purescience-annotation-mcp'])
    const env = Object.fromEntries((config.env ?? []).map((entry) => [entry.name, entry.value]))
    expect(env.PURESCIENCE_ANNOTATION_RPC_ENDPOINT).toBe('http://127.0.0.1:8642')
    expect(env.PURESCIENCE_ANNOTATION_PROJECT_ID).toBe('project-1')
  })

  it('round-trips a set call through the handler', async () => {
    const handler = makeHandler()
    const server = createAnnotationMcpServer(handler)
    const tools = (server as unknown as { _registeredTools: Record<string, unknown> })
      ._registeredTools
    const setTool = tools[ANNOTATION_SET_TOOL_NAME] as {
      handler: (input: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[] }>
    }
    const result = await setTool.handler({
      target: 'src/main.ts',
      label: 'todo',
      note: 'Refactor the parsing loop.'
    })
    expect(handler.set).toHaveBeenCalledWith({
      target: 'src/main.ts',
      label: 'todo',
      note: 'Refactor the parsing loop.',
      fileSha256: undefined
    })
    expect(result.content[0]?.text).toContain('replaced')
  })
})
