// Knowledge MCP server contract: name/arg/env wiring, the three registered tools, and the one narrowing the
// server does itself (a kind with no matching path/url is refused before it reaches the main process).

import { describe, expect, it, vi } from 'vitest'

import {
  KNOWLEDGE_MCP_SERVER_ARG,
  KNOWLEDGE_MCP_SERVER_NAME,
  createKnowledgeMcpEnvironmentFromProcess,
  createKnowledgeMcpServer,
  createKnowledgeMcpServerConfig,
  knowledgeListSourcesToolDefinition,
  knowledgeRenderWikiToolDefinition,
  knowledgeRemoveSourceToolDefinition,
  knowledgeRegisterSourceToolDefinition,
  knowledgeSearchToolDefinition,
  registrationFrom
} from './knowledge-mcp-server'
import type { KnowledgeMcpHandler } from './knowledge-mcp-server'
import {
  KNOWLEDGE_LIST_SOURCES_TOOL_NAME,
  KNOWLEDGE_REMOVE_SOURCE_TOOL_NAME,
  KNOWLEDGE_RENDER_WIKI_TOOL_NAME,
  KNOWLEDGE_REGISTER_SOURCE_TOOL_NAME,
  KNOWLEDGE_SEARCH_TOOL_NAME
} from '../../shared/knowledge-mcp'

const makeHandler = (): KnowledgeMcpHandler => ({
  search: vi.fn(async () => ({
    status: 'ok' as const,
    mode: 'lexical' as const,
    degradation: 'semantic-source-unconfigured' as const,
    verification: 'checked' as const,
    coverage: { indexed: 1, pending: 0 },
    results: [
      {
        sourceId: 'source-1',
        label: 'notes.md',
        locator: { kind: 'file' as const, path: '/managed/notes.md', startLine: 2, endLine: 2 },
        sha256: 'a'.repeat(64),
        lexicalOnly: true as const
      }
    ]
  })),
  registerSource: vi.fn(async () => []),
  listSources: vi.fn(async () => ({ sources: [], unreadable: false })),
  renderWiki: vi.fn(async () => ({ state: 'empty-folder' as const })),
  removeSource: vi.fn(async () => ({
    removed: {} as never,
    prunedContents: [] as string[]
  }))
})

describe('knowledge MCP server contract', () => {
  it('names the server and its five tools', () => {
    expect(KNOWLEDGE_MCP_SERVER_NAME).toBe('purescience-knowledge')
    expect(KNOWLEDGE_MCP_SERVER_ARG).toBe('--purescience-knowledge-mcp')
    expect(KNOWLEDGE_SEARCH_TOOL_NAME).toBe('knowledge_search')
    expect(KNOWLEDGE_REGISTER_SOURCE_TOOL_NAME).toBe('knowledge_register_source')
    expect(KNOWLEDGE_LIST_SOURCES_TOOL_NAME).toBe('knowledge_list_sources')
    expect(KNOWLEDGE_RENDER_WIKI_TOOL_NAME).toBe('knowledge_render_wiki')
    expect(KNOWLEDGE_REMOVE_SOURCE_TOOL_NAME).toBe('knowledge_remove_source')
  })

  it('registers exactly five tools and calls nothing until invoked', async () => {
    const handler = makeHandler()
    const server = createKnowledgeMcpServer(handler)
    const tools = (server as unknown as { _registeredTools: Record<string, unknown> })
      ._registeredTools

    expect(Object.keys(tools).sort()).toEqual([
      'knowledge_list_sources',
      'knowledge_register_source',
      'knowledge_remove_source',
      'knowledge_render_wiki',
      'knowledge_search'
    ])
    expect(handler.search).not.toHaveBeenCalled()
    expect(handler.registerSource).not.toHaveBeenCalled()
    expect(handler.listSources).not.toHaveBeenCalled()
    expect(handler.renderWiki).not.toHaveBeenCalled()
    expect(handler.removeSource).not.toHaveBeenCalled()
  })

  // The descriptions are the model's only contract with the store: they must say lexical, name the degradation,
  // and refuse to let "not indexed" pass for "nothing there".
  it('describes search as lexical and names the degradation', () => {
    const description = knowledgeSearchToolDefinition.description
    expect(description).toContain('LEXICAL')
    expect(description).toContain('semantic-source-unconfigured')
    expect(description).toContain('not-indexed')
    expect(description).toMatch(/sha256/)
  })

  // The wiki must not promise to place the file: choosing a path is the caller's decision.
  it('describes removal as reporting what it pruned', () => {
    const description = knowledgeRemoveSourceToolDefinition.description
    expect(description).toContain('pruned')
    expect(description).toContain('source-not-found')
  })

  it('describes the wiki as rendered, never written', () => {
    const description = knowledgeRenderWikiToolDefinition.description
    expect(description).toContain('Nothing is written')
    expect(description).toContain('empty-folder')
    expect(description).toContain('unreadable-folder')
  })

  it('offers no semantic mode and no copy of the content anywhere', () => {
    expect(knowledgeSearchToolDefinition.description).not.toMatch(/embedding-based results/i)
    expect(knowledgeRegisterSourceToolDefinition.description).toContain('does not copy the content')
    expect(knowledgeListSourcesToolDefinition.description).toContain('unreadable')
  })

  it('builds a stdio server config with the knowledge env', () => {
    const config = createKnowledgeMcpServerConfig({
      command: '/usr/local/bin/purescience',
      entryPath: '/app/out/main/index.js',
      endpoint: 'http://127.0.0.1:8642',
      token: 'tok-123',
      sessionId: 'session-9',
      projectId: 'project-9'
    })

    expect(config.name).toBe('purescience-knowledge')
    expect(config.args).toEqual(['/app/out/main/index.js', '--purescience-knowledge-mcp'])
    expect(config.env).toEqual(
      expect.arrayContaining([
        { name: 'PURESCIENCE_KNOWLEDGE_RPC_ENDPOINT', value: 'http://127.0.0.1:8642' },
        { name: 'PURESCIENCE_KNOWLEDGE_RPC_TOKEN', value: 'tok-123' },
        { name: 'PURESCIENCE_KNOWLEDGE_SESSION_ID', value: 'session-9' },
        { name: 'PURESCIENCE_KNOWLEDGE_PROJECT_ID', value: 'project-9' }
      ])
    )
  })

  it('passes the socket path only when there is one', () => {
    const withSocket = createKnowledgeMcpServerConfig({
      command: 'cmd',
      entryPath: '/entry.js',
      endpoint: 'http://127.0.0.1:1',
      socketPath: '/tmp/rpc.sock',
      token: 't',
      sessionId: 's',
      projectId: 'p'
    })
    const withoutSocket = createKnowledgeMcpServerConfig({
      command: 'cmd',
      entryPath: '/entry.js',
      endpoint: 'http://127.0.0.1:1',
      token: 't',
      sessionId: 's',
      projectId: 'p'
    })

    expect(withSocket.env).toContainEqual({
      name: 'PURESCIENCE_KNOWLEDGE_RPC_SOCKET_PATH',
      value: '/tmp/rpc.sock'
    })
    expect(withoutSocket.env?.map((entry) => entry.name)).not.toContain(
      'PURESCIENCE_KNOWLEDGE_RPC_SOCKET_PATH'
    )
  })

  it('refuses a kind with no matching path or url before it reaches the store', () => {
    expect(() => registrationFrom({ kind: 'url' })).toThrow(/requires a url/)
    expect(() => registrationFrom({ kind: 'file' })).toThrow(/requires a path/)
    expect(() => registrationFrom({ kind: 'folder' })).toThrow(/requires a path/)
    expect(registrationFrom({ kind: 'file', path: '/a.md' })).toEqual({
      kind: 'file',
      path: '/a.md'
    })
    expect(registrationFrom({ kind: 'url', url: 'https://example.org' })).toEqual({
      kind: 'url',
      url: 'https://example.org'
    })
  })

  it('names the missing environment variable instead of starting with an empty endpoint', () => {
    expect(() => createKnowledgeMcpEnvironmentFromProcess({})).toThrow(
      /Missing knowledge MCP environment variable: PURESCIENCE_KNOWLEDGE_RPC_ENDPOINT/
    )
    expect(
      createKnowledgeMcpEnvironmentFromProcess({
        PURESCIENCE_KNOWLEDGE_RPC_ENDPOINT: 'http://127.0.0.1:1',
        PURESCIENCE_KNOWLEDGE_RPC_TOKEN: 't',
        PURESCIENCE_KNOWLEDGE_SESSION_ID: 's',
        PURESCIENCE_KNOWLEDGE_PROJECT_ID: 'p'
      })
    ).toEqual({
      endpoint: 'http://127.0.0.1:1',
      socketPath: undefined,
      token: 't',
      sessionId: 's',
      projectId: 'p'
    })
  })
})
