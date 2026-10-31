import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { EXTERNAL_MCP_STATE_FILE } from './state-file'
import { EXTERNAL_MCP_TOOLS } from './surface'
import {
  EXTERNAL_MCP_WRITE_TOOL_IDS,
  ExternalMcpServer,
  type ExternalMcpInvoke,
  type ExternalMcpRequestApproval
} from './server'

// Capture the operational line without a real logger: the record shape is what the audit contract names,
// so it is asserted as data rather than as console formatting.
const { externalMcpLogs } = vi.hoisted(() => ({
  externalMcpLogs: [] as { level: string; message: string; payload: Record<string, unknown> }[]
}))
vi.mock('../logger', () => ({
  createLogger: () => ({
    debug: () => undefined,
    info: (message: string, payload: Record<string, unknown>) => {
      externalMcpLogs.push({ level: 'info', message, payload })
    },
    warn: (message: string, payload: Record<string, unknown>) => {
      externalMcpLogs.push({ level: 'warn', message, payload })
    },
    error: () => undefined
  })
}))

const scratchRoots: string[] = []
const servers: ExternalMcpServer[] = []
const clients: Client[] = []

const scratchRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'ps-external-mcp-'))
  scratchRoots.push(root)
  return root
}

afterEach(async (): Promise<void> => {
  for (const client of clients.splice(0)) await client.close().catch(() => undefined)
  for (const server of servers.splice(0)) await server.stop().catch(() => undefined)
  for (const root of scratchRoots.splice(0)) await rm(root, { recursive: true, force: true })
})

const projects = [
  { id: 'p1', name: 'Alpha' },
  { id: 'p2', name: 'Beta', description: 'second library' }
]

const catalog = {
  sessions: [
    {
      id: 's1',
      projectId: 'p1',
      title: 'Docking run',
      status: 'idle',
      cwd: '/tmp/a',
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_500_000,
      messageCount: 2
    },
    {
      id: 's2',
      projectId: 'p2',
      title: 'Review',
      status: 'done',
      cwd: '/tmp/b',
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_600_000,
      messageCount: 0
    }
  ]
}

const documents: Record<string, unknown> = {
  s1: {
    id: 's1',
    projectId: 'p1',
    title: 'Docking run',
    status: 'idle',
    cwd: '/tmp/a',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_500_000,
    messages: [
      { id: 'm1', role: 'user', status: 'complete', content: 'hello' },
      { id: 'm2', role: 'agent', status: 'complete', content: 'world' }
    ]
  }
}

// A stand-in for the application command router: it answers only the commands the surface declares, so a
// handler reaching for anything else fails the test rather than silently returning undefined.
const fakeInvoke = (): ExternalMcpInvoke & {
  calls: { commandName: string; args: readonly unknown[] }[]
} => {
  const calls: { commandName: string; args: readonly unknown[] }[] = []
  const invoke = (async (input: {
    clientId: string
    commandName: string
    args: readonly unknown[]
  }): Promise<unknown> => {
    calls.push({ commandName: input.commandName, args: input.args })
    if (input.commandName === 'projects:list') return projects
    if (input.commandName === 'sessions:list-catalog') return catalog
    if (input.commandName === 'sessions:read-document') {
      const requested = (input.args[0] as { sessionId?: string } | undefined)?.sessionId ?? ''
      const document = documents[requested]
      if (!document) throw new Error(`Session not found: ${requested}`)
      return document
    }
    if (input.commandName === 'artifacts:list-project-files') {
      return [{ id: 'f1', kind: 'file', name: 'notes.md', path: '/tmp/a/notes.md' }]
    }
    if (input.commandName === 'sessions:update-archive') {
      const request = input.args[0] as {
        projectId: string
        sessionId: string
        archived: boolean
        expectedArchivedAt: number | null
      }
      return { ...(documents[request.sessionId] as object), archivedAt: 1_700_000_900_000 }
    }
    throw new Error(`unexpected command ${input.commandName}`)
  }) as ExternalMcpInvoke & { calls: typeof calls }
  invoke.calls = calls
  return invoke
}

const startServer = async (
  invoke: ExternalMcpInvoke,
  requestApproval?: ExternalMcpRequestApproval
): Promise<{ server: ExternalMcpServer; endpoint: string; token: string; configRoot: string }> => {
  const configRoot = await scratchRoot()
  const server = new ExternalMcpServer({
    invoke,
    configRoot,
    ...(requestApproval ? { requestApproval } : {})
  })
  servers.push(server)
  const started = await server.start()
  return { server, endpoint: started.endpoint, token: started.token, configRoot }
}

const connect = async (endpoint: string, token: string): Promise<Client> => {
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: { headers: { authorization: `Bearer ${token}` } }
  })
  const client = new Client({ name: 'external-client-test', version: '1.0.0' })
  clients.push(client)
  await client.connect(transport)
  return client
}

const textOf = (result: unknown): unknown => {
  const content = (result as { content?: { type: string; text?: string }[] }).content ?? []
  const first = content.find((entry) => entry.type === 'text')
  return first?.text === undefined ? undefined : JSON.parse(first.text)
}

describe('external MCP server', () => {
  it('serves tools/list straight from the declared surface', async () => {
    const { endpoint, token } = await startServer(fakeInvoke())
    const client = await connect(endpoint, token)

    const listed = await client.listTools()
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual(
      EXTERNAL_MCP_TOOLS.map((tool) => tool.id).sort()
    )
    for (const tool of listed.tools) {
      const declared = EXTERNAL_MCP_TOOLS.find((entry) => entry.id === tool.name)
      expect(tool.description).toBe(declared?.description)
      expect(tool.inputSchema).toEqual(declared?.inputSchema)
    }
  })

  it('answers a read tool with the app’s own data through the injected port', async () => {
    const invoke = fakeInvoke()
    const { endpoint, token } = await startServer(invoke)
    const client = await connect(endpoint, token)

    const result = await client.callTool({ name: 'list_projects', arguments: {} })
    expect(textOf(result)).toEqual({ count: 2, projects: projects })
    expect(invoke.calls.map((call) => call.commandName)).toEqual(['projects:list'])
  })

  it('narrows list_sessions by an id or an exact name, and refuses a name it does not know', async () => {
    const { endpoint, token } = await startServer(fakeInvoke())
    const client = await connect(endpoint, token)

    const byName = await client.callTool({ name: 'list_sessions', arguments: { project: 'Beta' } })
    const narrowed = textOf(byName) as {
      count: number
      projectId: string
      sessions: { id: string }[]
    }
    expect(narrowed.projectId).toBe('p2')
    expect(narrowed.sessions.map((session) => session.id)).toEqual(['s2'])

    const all = textOf(await client.callTool({ name: 'list_sessions', arguments: {} })) as {
      count: number
      sessions: { id: string; updatedAt?: string }[]
    }
    expect(all.count).toBe(2)
    // Message counts and timestamps come from the catalog, not from an empty `messages` array.
    expect(all.sessions.map((session) => session.id)).toEqual(['s1', 's2'])
    expect(all.sessions[0]?.updatedAt).toBe(new Date(1_700_000_500_000).toISOString())
    expect(all.sessions[1]?.updatedAt).toBe(new Date(1_700_000_600_000).toISOString())

    // A typo must not quietly answer with every project's sessions.
    const refused = await client.callTool({ name: 'list_sessions', arguments: { project: 'Bet' } })
    expect(refused.isError).toBe(true)
    expect(textOf(refused)).toMatchObject({ error: { code: 'project-not-found' } })
  })

  it('passes the resolved project id to the artifacts command, not the name the client typed', async () => {
    // The artifacts command keys its storage directory by project **id** even though its request field is
    // called `projectName`: a display name with a space is refused there as an unsafe path segment
    // (measured: "Invalid artifact path segment: F1 probe project"). So the tool must resolve the name
    // against the app's own list and send the id.
    const invoke = fakeInvoke()
    const { endpoint, token } = await startServer(invoke)
    const client = await connect(endpoint, token)

    const byName = textOf(
      await client.callTool({ name: 'list_project_files', arguments: { project: 'Beta' } })
    ) as { projectId: string; count: number; files: unknown[] }
    expect(byName.projectId).toBe('p2')
    expect(byName.count).toBe(1)

    const artifactCall = invoke.calls.filter(
      (call) => call.commandName === 'artifacts:list-project-files'
    )
    expect(artifactCall.map((call) => call.args[0])).toEqual([{ projectName: 'p2' }])

    const refused = await client.callTool({
      name: 'list_project_files',
      arguments: { project: 'Bet' }
    })
    expect(refused.isError).toBe(true)
    expect(textOf(refused)).toMatchObject({ error: { code: 'project-not-found' } })
  })

  it('reads one session and states whether the message list was truncated', async () => {
    const { endpoint, token } = await startServer(fakeInvoke())
    const client = await connect(endpoint, token)

    const excerpt = textOf(
      await client.callTool({ name: 'read_session', arguments: { sessionId: 's1', limit: 1 } })
    ) as {
      messagesReturned: number
      messageCount: number
      truncated: boolean
      messages: { content: string }[]
    }
    expect(excerpt.messagesReturned).toBe(1)
    expect(excerpt.messageCount).toBe(2)
    expect(excerpt.truncated).toBe(true)
    expect(excerpt.messages.map((message) => message.content)).toEqual(['world'])
  })

  it('refuses a missing argument and an unknown session by name, without calling the command', async () => {
    const invoke = fakeInvoke()
    const { endpoint, token } = await startServer(invoke)
    const client = await connect(endpoint, token)

    const missing = await client.callTool({ name: 'read_session', arguments: {} })
    expect(missing.isError).toBe(true)
    expect(textOf(missing)).toMatchObject({ error: { code: 'missing-argument' } })
    expect(invoke.calls.some((call) => call.commandName === 'sessions:read-document')).toBe(false)

    const unknown = await client.callTool({
      name: 'read_session',
      arguments: { sessionId: 'nope' }
    })
    expect(unknown.isError).toBe(true)
    expect(textOf(unknown)).toMatchObject({ error: { code: 'session-not-found' } })
  })

  it('refuses a tool it never declared', async () => {
    const invoke = fakeInvoke()
    const { endpoint, token } = await startServer(invoke)
    const client = await connect(endpoint, token)

    const refused = await client.callTool({ name: 'run_shell', arguments: { command: 'ls' } })
    expect(refused.isError).toBe(true)
    expect(textOf(refused)).toMatchObject({ error: { code: 'unknown-tool' } })
    expect(invoke.calls).toEqual([])
  })

  it('refuses a write tool when no approval surface is reachable, and changes nothing', async () => {
    // No port at all: an app started without an approval surface must not perform an outside client's
    // write on that client's word. The refusal is named and the command is never invoked.
    const invoke = fakeInvoke()
    const { endpoint, token } = await startServer(invoke)
    const client = await connect(endpoint, token)

    const refused = await client.callTool({
      name: 'archive_session',
      arguments: { sessionId: 's1' }
    })
    expect(refused.isError).toBe(true)
    expect(textOf(refused)).toMatchObject({ error: { code: 'approval-unavailable' } })
    // The message has to say what did not happen, not just "denied".
    expect(JSON.stringify(textOf(refused))).toContain('Nothing was changed.')
    // The target lookup is a read and runs first (that is how the card can name the conversation); the
    // write itself is never sent.
    expect(invoke.calls.map((call) => call.commandName)).toEqual(['sessions:list-catalog'])

    const line = externalMcpLogs
      .filter((entry) => entry.message === 'external mcp call')
      .at(-1)?.payload
    expect(line).toMatchObject({
      tool: 'archive_session',
      risk: 'write',
      outcome: 'refused',
      code: 'approval-unavailable'
    })
  })

  it('runs a write only after the card approves it, and audits the decision on the same call line', async () => {
    const invoke = fakeInvoke()
    const approvalRequests: {
      toolId: string
      toolCallId: string
      sessionId: string | undefined
      title: string
      rawInput: unknown
    }[] = []
    const requestApproval: ExternalMcpRequestApproval = async (input) => {
      approvalRequests.push({
        toolId: input.toolId,
        toolCallId: input.toolCallId,
        sessionId: input.sessionId,
        title: input.title,
        rawInput: input.rawInput
      })
      return 'approved'
    }
    const { endpoint, token } = await startServer(invoke, requestApproval)
    const client = await connect(endpoint, token)

    const result = await client.callTool({
      name: 'archive_session',
      arguments: { sessionId: 's1' }
    })
    expect(result.isError).toBeUndefined()
    expect(textOf(result)).toEqual({
      sessionId: 's1',
      projectId: 'p1',
      archived: true,
      archivedAt: 1_700_000_900_000
    })

    // The request the app actually sent: project id and the expected prior state come from the list row,
    // not from the client's argument list.
    const archiveCall = invoke.calls.find((call) => call.commandName === 'sessions:update-archive')
    expect(archiveCall?.args).toEqual([
      { projectId: 'p1', sessionId: 's1', archived: true, expectedArchivedAt: null }
    ])

    // The card asked about this conversation, and the id it was parked under is the one the audit line
    // carries — that pairing is how "who approved what" is answerable afterwards.
    expect(approvalRequests).toHaveLength(1)
    expect(approvalRequests[0]).toMatchObject({
      toolId: 'archive_session',
      sessionId: 's1',
      // The card shows what the plan resolved — the project id came from the list row, not from the client.
      rawInput: { sessionId: 's1', projectId: 'p1', archived: true }
    })
    // …and it names the conversation, so the reader approves something recognisable.
    expect(approvalRequests[0]?.title).toContain('Docking run')
    // The read that resolved the target happened before the card was shown.
    expect(invoke.calls.map((call) => call.commandName)).toEqual([
      'sessions:list-catalog',
      'sessions:update-archive'
    ])

    const line = externalMcpLogs
      .filter((entry) => entry.message === 'external mcp call')
      .at(-1)?.payload
    expect(line).toMatchObject({
      tool: 'archive_session',
      risk: 'write',
      outcome: 'ok',
      decision: 'approved'
    })
    expect(line?.toolCallId).toBe(approvalRequests[0]?.toolCallId)
  })

  it('does not run a write the user declined, and reports the refusal by name', async () => {
    const invoke = fakeInvoke()
    const requestApproval: ExternalMcpRequestApproval = async () => 'declined'
    const { endpoint, token } = await startServer(invoke, requestApproval)
    const client = await connect(endpoint, token)

    const refused = await client.callTool({
      name: 'archive_session',
      arguments: { sessionId: 's1' }
    })
    expect(refused.isError).toBe(true)
    expect(textOf(refused)).toMatchObject({ error: { code: 'not-approved' } })
    // Declined means declined: the target lookup is the only command that ran.
    expect(invoke.calls.map((call) => call.commandName)).toEqual(['sessions:list-catalog'])

    const line = externalMcpLogs
      .filter((entry) => entry.message === 'external mcp call')
      .at(-1)?.payload
    expect(line).toMatchObject({
      tool: 'archive_session',
      outcome: 'refused',
      code: 'not-approved',
      decision: 'declined'
    })
  })

  it('refuses archiving a session it does not hold, before asking anybody', async () => {
    const invoke = fakeInvoke()
    let asked = 0
    const requestApproval: ExternalMcpRequestApproval = async () => {
      asked += 1
      return 'approved'
    }
    const { endpoint, token } = await startServer(invoke, requestApproval)
    const client = await connect(endpoint, token)

    const refused = await client.callTool({
      name: 'archive_session',
      arguments: { sessionId: 'no-such-session' }
    })
    expect(refused.isError).toBe(true)
    expect(textOf(refused)).toMatchObject({ error: { code: 'session-not-found' } })
    // A card for a session that does not exist would waste the reader's attention on a call that cannot
    // work; the lookup happens first.
    expect(asked).toBe(0)
    expect(invoke.calls.map((call) => call.commandName)).toEqual(['sessions:list-catalog'])
  })

  it('keeps the write ids in one list, paired with the surface', async () => {
    // The dispatch path decides "needs the card" from `risk`, and picks the planner from the id list. If the
    // two disagree, a write either loses its gate or has no planner at all — both are wiring bugs, and the
    // only place they can be caught before a real client hits them is here.
    expect(
      EXTERNAL_MCP_TOOLS.filter((tool) => tool.risk === 'write').map((tool) => tool.id)
    ).toEqual([...EXTERNAL_MCP_WRITE_TOOL_IDS])
    // And every declared tool answers through the real dispatch path: none of them is a surface row with no
    // implementation behind it.
    const invoke = fakeInvoke()
    const { endpoint, token } = await startServer(invoke, async () => 'approved')
    const client = await connect(endpoint, token)
    for (const tool of EXTERNAL_MCP_TOOLS) {
      const argument =
        tool.id === 'list_project_files'
          ? { project: 'p1' }
          : tool.id === 'archive_session' || tool.id === 'read_session'
            ? { sessionId: 's1' }
            : {}
      const result = await client.callTool({ name: tool.id, arguments: argument })
      expect(JSON.stringify(textOf(result))).not.toContain('permission-gate-not-wired')
    }
  })
})

describe('external MCP transport guards', () => {
  it('publishes the endpoint for the CLI and withdraws it on stop', async () => {
    const { endpoint, token, configRoot, server } = await startServer(fakeInvoke())
    const statePath = join(configRoot, EXTERNAL_MCP_STATE_FILE)

    const published = JSON.parse(await readFile(statePath, 'utf8')) as {
      pid: number
      endpoint: string
      token: string
    }
    expect(published.endpoint).toBe(endpoint)
    expect(published.token).toBe(token)
    expect(published.pid).toBe(process.pid)
    // Own-user only: the token is a secret that must not be world-readable. NTFS has no POSIX mode bits —
    // Node synthesises them from the file's ACL, so a correctly-protected file still reports 0o66 here and
    // an assertion on the mode would fail for the wrong reason. The property that matters on Windows (the
    // ACL inherits from the per-user config directory) is not expressible as a mode, so this half of the
    // assertion is POSIX-only, the same way the repository's other mode checks are.
    if (process.platform !== 'win32') {
      expect((await stat(statePath)).mode & 0o077).toBe(0)
    }

    await server.stop()
    await expect(stat(statePath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects a request without the bearer token before it reaches the tools', async () => {
    const { endpoint } = await startServer(fakeInvoke())
    const unauthenticated = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    })
    expect(unauthenticated.status).toBe(401)

    const wrongToken = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: 'Bearer not-the-token'
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    })
    expect(wrongToken.status).toBe(401)
  })

  it('refuses a request addressed to a non-loopback host, so a rebinding page cannot reach it', async () => {
    const { endpoint, token } = await startServer(fakeInvoke())
    // `Host` is a forbidden header for fetch, so the guard has to be exercised with a raw request: a page
    // that resolves its own name to 127.0.0.1 sends its own Host and must be refused before the token is
    // even compared.
    const status = await new Promise<number>((resolve, reject) => {
      const url = new URL(endpoint)
      const payload = Buffer.from(
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
        'utf8'
      )
      const request = httpRequest(
        {
          host: url.hostname,
          port: Number(url.port),
          path: url.pathname,
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            'content-length': String(payload.length),
            authorization: `Bearer ${token}`,
            host: 'example.com'
          }
        },
        (response) => {
          response.resume()
          resolve(response.statusCode ?? 0)
        }
      )
      request.on('error', reject)
      request.write(payload)
      request.end()
    })
    expect(status).toBe(421)
  })

  it('stops idempotently, and a failed start never deletes a state file it did not write', async () => {
    const configRoot = await scratchRoot()
    // Occupy the state-file path with a directory: the writer cannot rename over it, so `start` fails after
    // it has bound the port. That is the shape of a real failure (unwritable config root), and it must
    // leave nothing behind and still close the listener.
    const { mkdir } = await import('node:fs/promises')
    const occupied = join(configRoot, EXTERNAL_MCP_STATE_FILE)
    await mkdir(occupied)

    const broken = new ExternalMcpServer({ invoke: fakeInvoke(), configRoot })
    await expect(broken.start()).rejects.toBeDefined()
    await broken.stop()
    await broken.stop()
    expect((await stat(occupied)).isDirectory()).toBe(true)
  })
})

describe('external MCP logging', () => {
  it('leaves one line per call with the tool, its outcome and a duration', async () => {
    externalMcpLogs.length = 0
    const { endpoint, token } = await startServer(fakeInvoke())
    const client = await connect(endpoint, token)
    await client.callTool({ name: 'list_projects', arguments: {} })
    await client.callTool({ name: 'read_session', arguments: {} })

    const calls = externalMcpLogs.filter((entry) => entry.message === 'external mcp call')
    expect(calls.length).toBe(2)
    const [ok, refused] = calls
    expect(ok?.payload).toMatchObject({ tool: 'list_projects', risk: 'read', outcome: 'ok' })
    expect(refused?.payload).toMatchObject({
      tool: 'read_session',
      outcome: 'refused',
      code: 'missing-argument'
    })
    // A duration is a number on every line, and the tool call id is what pairs a line with its outcome.
    for (const entry of calls) {
      expect(typeof entry.payload.durationMs).toBe('number')
      expect(typeof entry.payload.toolCallId).toBe('string')
    }
    // The token is a secret: it must never appear in a log payload.
    expect(JSON.stringify(calls)).not.toContain(token)
  })
})
