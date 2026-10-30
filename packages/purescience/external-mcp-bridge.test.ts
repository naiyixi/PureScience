import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { afterEach, describe, expect, it } from 'vitest'

import { CliUsageError, parseCliArgs } from './cli.mjs'
import {
  EXIT_APP_NOT_RUNNING,
  EXIT_OK,
  EXIT_STATE_UNUSABLE,
  EXTERNAL_MCP_STATE_FILE,
  findExternalMcpState,
  listExternalMcpTools,
  runExternalMcpBridge
} from './external-mcp-bridge.mjs'

const scratchRoots: string[] = []
const stubServers: Server[] = []

const scratchRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'ps-cli-mcp-'))
  scratchRoots.push(root)
  return root
}

afterEach(async (): Promise<void> => {
  for (const server of stubServers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  for (const root of scratchRoots.splice(0)) await rm(root, { recursive: true, force: true })
})

const writeState = async (configRoot: string, state: Record<string, unknown>): Promise<string> => {
  const path = join(configRoot, EXTERNAL_MCP_STATE_FILE)
  await writeFile(path, JSON.stringify(state), 'utf8')
  return path
}

// A stand-in for the app's endpoint: it answers JSON-RPC over one POST, the way the streamable HTTP
// transport does when asked for a JSON response.
const startStub = async (
  handler: (body: {
    id?: unknown
    method?: string
    params?: unknown
  }) => { status: number; payload?: unknown } | Promise<{ status: number; payload?: unknown }>
): Promise<{ endpoint: string; requests: { method?: string; authorization?: string }[] }> => {
  const requests: { method?: string; authorization?: string }[] = []
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      void (async (): Promise<void> => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
        requests.push({
          method: body.method,
          authorization: request.headers.authorization
        })
        const answer = await handler(body)
        const headers: Record<string, string> = { 'content-type': 'application/json' }
        if (answer.status === 200) headers['mcp-session-id'] = 'stub-session'
        response.writeHead(answer.status, headers)
        response.end(answer.payload === undefined ? '' : JSON.stringify(answer.payload))
      })()
    })
  })
  stubServers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return { endpoint: `http://127.0.0.1:${port}/mcp`, requests }
}

describe('purescience mcp: published state', () => {
  it('reads the endpoint the running app published, and only from its own config root', async () => {
    const configRoot = await scratchRoot()
    await writeState(configRoot, {
      pid: process.pid,
      endpoint: 'http://127.0.0.1:51234/mcp',
      token: 'token-1',
      startedAt: new Date(0).toISOString()
    })

    const state = await findExternalMcpState({ override: configRoot })
    expect(state).toMatchObject({ endpoint: 'http://127.0.0.1:51234/mcp', configRoot })
    // An explicit root must not fall back to the machine's real config: that is how a probe ends up
    // talking to the user's live app.
    const elsewhere = await scratchRoot()
    expect(await findExternalMcpState({ override: elsewhere })).toBeUndefined()
  })

  it('treats a state file whose owner is gone as "not running" instead of handing back its token', async () => {
    const configRoot = await scratchRoot()
    await writeState(configRoot, {
      pid: 2_147_483_646,
      endpoint: 'http://127.0.0.1:51234/mcp',
      token: 'token-1',
      startedAt: new Date(0).toISOString()
    })
    expect(await findExternalMcpState({ override: configRoot })).toBeUndefined()
  })

  it('ignores a corrupt state file and one that is missing fields', async () => {
    const corrupt = await scratchRoot()
    await writeFile(join(corrupt, EXTERNAL_MCP_STATE_FILE), '{not json', 'utf8')
    expect(await findExternalMcpState({ override: corrupt })).toBeUndefined()

    const incomplete = await scratchRoot()
    await writeState(incomplete, { pid: process.pid, endpoint: 'http://127.0.0.1:1/mcp' })
    expect(await findExternalMcpState({ override: incomplete })).toBeUndefined()
  })

  it('accepts the config root from the environment the way the rest of the CLI does', async () => {
    const configRoot = await scratchRoot()
    await writeState(configRoot, {
      pid: process.pid,
      endpoint: 'http://127.0.0.1:51234/mcp',
      token: 'token-1',
      startedAt: new Date(0).toISOString()
    })
    const state = await findExternalMcpState({ env: { PURESCIENCE_CONFIG_ROOT: configRoot } })
    expect(state?.endpoint).toBe('http://127.0.0.1:51234/mcp')
  })
})

describe('purescience mcp: the stdio bridge', () => {
  it('forwards one request and writes one reply line, then ends cleanly when the client closes stdin', async () => {
    const stub = await startStub((body) => ({
      status: 200,
      payload: { jsonrpc: '2.0', id: body.id, result: { tools: [] } }
    }))
    const written: string[] = []
    const input = Readable.from([
      `${JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list', params: {} })}\n`
    ])

    const code = await runExternalMcpBridge({
      state: { endpoint: stub.endpoint, token: 'token-1' },
      input,
      write: (line: string) => written.push(line)
    })

    expect(code).toBe(EXIT_OK)
    expect(written).toHaveLength(1)
    expect(JSON.parse(written[0]!)).toEqual({ jsonrpc: '2.0', id: 7, result: { tools: [] } })
    // The bearer token travels on the wire but never into the stream the client reads.
    expect(stub.requests[0]?.authorization).toBe('Bearer token-1')
    expect(written.join('')).not.toContain('token-1')
  })

  it('carries the session id from the reply into the next request, so one conversation is one session', async () => {
    const stub = await startStub((body) => ({
      status: 200,
      payload: { jsonrpc: '2.0', id: body.id, result: {} }
    }))
    const written: string[] = []
    const input = Readable.from([
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`,
      `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`
    ])

    await runExternalMcpBridge({
      state: { endpoint: stub.endpoint, token: 'token-1' },
      input,
      write: (line: string) => written.push(line)
    })
    expect(written).toHaveLength(2)
    expect(stub.requests.map((request) => request.method)).toEqual(['initialize', 'tools/list'])
  })

  it('tells the client that the app is unreachable instead of leaving it waiting', async () => {
    const stub = await startStub(() => ({
      status: 200,
      payload: { jsonrpc: '2.0', id: 1, result: {} }
    }))
    const deadEndpoint = stub.endpoint
    await new Promise<void>((resolve) => stubServers.pop()?.close(() => resolve()))

    const written: string[] = []
    const code = await runExternalMcpBridge({
      state: { endpoint: deadEndpoint, token: 'token-1' },
      input: Readable.from([
        `${JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/list', params: {} })}\n`
      ]),
      write: (line: string) => written.push(line)
    })

    expect(code).toBe(EXIT_APP_NOT_RUNNING)
    const reply = JSON.parse(written[0]!) as {
      id: number
      error: { code: number; message: string }
    }
    expect(reply.id).toBe(5)
    expect(reply.error.code).toBe(-32001)
    expect(reply.error.message).toContain('not reachable')
  })

  it('reports an unusable published token as its own exit code', async () => {
    const stub = await startStub(() => ({ status: 401 }))
    const written: string[] = []
    const code = await runExternalMcpBridge({
      state: { endpoint: stub.endpoint, token: 'stale' },
      input: Readable.from([
        `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })}\n`
      ]),
      write: (line: string) => written.push(line)
    })
    expect(code).toBe(EXIT_STATE_UNUSABLE)
  })

  it('answers a malformed line with a JSON-RPC parse error rather than dying', async () => {
    const stub = await startStub((body) => ({
      status: 200,
      payload: { jsonrpc: '2.0', id: body.id, result: {} }
    }))
    const written: string[] = []
    const code = await runExternalMcpBridge({
      state: { endpoint: stub.endpoint, token: 'token-1' },
      input: Readable.from(['not json\n']),
      write: (line: string) => written.push(line)
    })
    expect(code).toBe(EXIT_OK)
    expect(JSON.parse(written[0]!)).toMatchObject({ id: null, error: { code: -32700 } })
    expect(stub.requests).toEqual([])
  })
})

describe('purescience mcp: --list-tools', () => {
  it('lists what the running app exposes, without leaving a stdio stream open', async () => {
    const stub = await startStub((body) => {
      if (body.method === 'initialize') {
        return {
          status: 200,
          payload: { jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18' } }
        }
      }
      if (body.method === 'tools/list') {
        return {
          status: 200,
          payload: {
            jsonrpc: '2.0',
            id: body.id,
            result: { tools: [{ name: 'list_projects', title: 'List projects', description: 'x' }] }
          }
        }
      }
      return { status: 202 }
    })

    const listed = await listExternalMcpTools({ endpoint: stub.endpoint, token: 'token-1' })
    expect(listed.ok).toBe(true)
    expect(listed.tools).toEqual([
      { name: 'list_projects', title: 'List projects', description: 'x' }
    ])
    expect(stub.requests.map((request) => request.method)).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/list'
    ])
  })

  it('names the reason when the endpoint answers without a session', async () => {
    const stub = await startStub(() => ({ status: 500 }))
    const listed = await listExternalMcpTools({ endpoint: stub.endpoint, token: 'token-1' })
    expect(listed.ok).toBe(false)
    expect(listed.exitCode).toBe(EXIT_STATE_UNUSABLE)
    expect(listed.detail).toContain('500')
  })
})

describe('purescience mcp: argument parsing', () => {
  it('parses the verb and its listing flag', () => {
    expect(parseCliArgs(['mcp'])).toMatchObject({ command: 'mcp' })
    expect(parseCliArgs(['mcp', '--list-tools', '--json'])).toMatchObject({
      command: 'mcp',
      options: { listTools: true, json: true }
    })
  })

  it('refuses the flag on any other verb', () => {
    expect(() => parseCliArgs(['status', '--list-tools'])).toThrow(CliUsageError)
  })
})
