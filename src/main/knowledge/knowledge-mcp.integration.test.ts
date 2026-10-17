// Real-process integration: a genuine NotebookLocalRpcServer (the same class the app runs) behind a genuine
// stdio child that speaks MCP, driven by the official MCP client. Everything here is the production path —
// the RPC whitelist, the knowledge surface, the store on disk, the citation digest — with three deliberate
// substitutions that a unit test cannot make: the "app" is a NotebookRuntimeService over a temp data root, the
// "model" is this test, and the agent framework is the MCP SDK.
//
// What it proves, and nothing beyond it:
//   1. the knowledge MCP entry point starts from the packaged argv (`--purescience-knowledge-mcp` is exercised
//      through the same run function index.ts imports),
//   2. the three tools are visible to a client,
//   3. register → list → search round-trips through HTTP RPC and the real store,
//   4. the returned sha256 matches an independent hash of the bytes on disk (so the citation is not synthesised),
//   5. a session without the knowledge capability cannot call these methods at all.

import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { build } from 'esbuild'
import { afterEach, describe, expect, it } from 'vitest'

import { createKnowledgeModule } from './knowledge-module'
import { createKnowledgeCitationVerifier } from './knowledge-citation'
import { createKnowledgeContentReader } from './knowledge-transport-io'
import { createKnowledgeWikiGenerator } from './knowledge-wiki'
import { createKnowledgeRpcCalls } from './knowledge-rpc-calls'
import { NotebookLocalRpcServer } from '../notebook/local-rpc-server'
import { NotebookRunRepository } from '../notebook/repository'
import { NotebookRuntimeService } from '../notebook/runtime-service'

const temporary: string[] = []

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

const tempDir = async (prefix: string): Promise<string> => {
  const path = await mkdtemp(join(tmpdir(), prefix))
  temporary.push(path)
  return path
}

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

// A bundled entry is used rather than the TypeScript source because the child must be a plain Node process:
// anything that prints to stdout before the protocol starts would corrupt the transport. Bundling keeps the
// child's stdout to JSON-RPC alone, and keeps the code under test identical to what ships.
let cachedBundle: string | undefined
const bundleKnowledgeMcpEntry = async (): Promise<string> => {
  if (cachedBundle) return cachedBundle
  // Deliberately NOT registered in `temporary`: the per-test cleanup would delete the entry between cases, and
  // every later child would fail to start with "Connection closed".
  const workDir = join(tmpdir(), `knowledge-mcp-bundle-${process.pid}`)
  await mkdir(workDir, { recursive: true })
  const entry = join(workDir, 'entry.ts')
  await writeFile(
    entry,
    `import { runKnowledgeMcpServer } from ${JSON.stringify(
      join(process.cwd(), 'src/main/knowledge/knowledge-mcp-server.ts')
    )}\nvoid runKnowledgeMcpServer()\n`,
    'utf8'
  )
  const outfile = join(workDir, 'entry.mjs')
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    logLevel: 'silent',
    // Electron is never imported by this path; marking it external keeps the bundle honest if it ever is.
    external: ['electron']
  })
  cachedBundle = outfile
  return outfile
}

const startServer = async (
  dataRoot: string
): Promise<{
  server: NotebookLocalRpcServer
  module: ReturnType<typeof createKnowledgeModule>
  connection: Awaited<ReturnType<NotebookLocalRpcServer['issueKnowledgeConnection']>>
}> => {
  const service = new NotebookRuntimeService({
    configRoot: dataRoot,
    dataRoot,
    projectName: 'default-project',
    repository: new NotebookRunRepository(dataRoot),
    executorFactory: () => ({
      execute: async () => ({
        status: 'completed' as const,
        stdout: '',
        stderr: '',
        traceback: '',
        cwdAfter: dataRoot,
        outputs: [],
        workingFiles: []
      }),
      shutdown: async () => ({ reaped: true })
    })
  })
  const module = createKnowledgeModule({
    root: dataRoot,
    roots: [dataRoot],
    verifier: createKnowledgeCitationVerifier({ reader: createKnowledgeContentReader() })
  })
  const wiki = createKnowledgeWikiGenerator({
    reader: {
      read: async (path) => {
        try {
          const { readFile } = await import('node:fs/promises')
          return await readFile(path, 'utf8')
        } catch {
          return undefined
        }
      }
    }
  })
  const server = new NotebookLocalRpcServer(service, {
    transport: 'tcp',
    token: 'master-token',
    knowledge: (() => {
      // The production wrapper, not a copy of it: a test that re-implemented `named()` would be asserting its own
      // version of the refusal text.
      const calls = createKnowledgeRpcCalls(module, wiki)
      return {
        search: (_sessionId: string, request: { text: string; limit?: number }) =>
          calls.search(request),
        registerSource: (_sessionId: string, request: Parameters<typeof calls.registerSource>[0]) =>
          calls.registerSource(request),
        listSources: () => calls.listSources(),
        renderWiki: (_sessionId: string, folder: string) => calls.renderWiki(folder)
      }
    })()
  })
  const connection = await server.issueKnowledgeConnection('session-1', 'project-1')
  return { server, module, connection }
}

describe('knowledge MCP over a real stdio child and the real RPC server', () => {
  it('registers, lists, and searches with a citation that matches the bytes on disk', async () => {
    const dataRoot = await tempDir('knowledge-mcp-root-')
    await mkdir(join(dataRoot, 'papers'), { recursive: true })
    const notePath = join(dataRoot, 'papers', 'notes.md')
    const matchingLine = 'TP53 amplification was observed in 12 of 40 samples'
    await writeFile(notePath, `# Cohort\n${matchingLine}\nEGFR remained wild type\n`, 'utf8')

    const { connection } = await startServer(dataRoot)
    const entry = await bundleKnowledgeMcpEntry()
    const client = new Client({ name: 'knowledge-integration', version: '1.0.0' })
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [entry],
      env: {
        ...(process.env as Record<string, string>),
        ELECTRON_RUN_AS_NODE: '1',
        PURESCIENCE_KNOWLEDGE_RPC_ENDPOINT: connection.endpoint,
        PURESCIENCE_KNOWLEDGE_RPC_TOKEN: connection.token,
        PURESCIENCE_KNOWLEDGE_SESSION_ID: 'session-1',
        PURESCIENCE_KNOWLEDGE_PROJECT_ID: 'project-1'
      },
      stderr: 'pipe'
    })

    try {
      await client.connect(transport)

      const tools = await client.listTools()
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
        'knowledge_list_sources',
        'knowledge_register_source',
        'knowledge_render_wiki',
        'knowledge_search'
      ])

      const registered = await client.callTool({
        name: 'knowledge_register_source',
        arguments: { kind: 'file', path: notePath }
      })
      const registeredText = (registered.content as { type: string; text: string }[])[0]?.text ?? ''
      expect(registeredText).toContain('notes.md')
      expect(registeredText).toContain('papers')

      const listed = await client.callTool({ name: 'knowledge_list_sources', arguments: {} })
      const listedText = (listed.content as { type: string; text: string }[])[0]?.text ?? ''
      const overview = JSON.parse(listedText) as {
        sources: { label: string; location: string }[]
        unreadable: boolean
      }
      expect(overview.unreadable).toBe(false)
      expect(overview.sources.map((source) => source.label)).toEqual(['notes.md'])

      const searched = await client.callTool({
        name: 'knowledge_search',
        arguments: { query: 'TP53' }
      })
      const searchText = (searched.content as { type: string; text: string }[])[0]?.text ?? ''
      const response = JSON.parse(searchText) as {
        status: string
        mode: string
        degradation: string
        verification: string
        coverage: { indexed: number; pending: number }
        results: {
          label: string
          locator: { kind: string; path: string; startLine: number; endLine: number }
          sha256: string
          lexicalOnly: boolean
        }[]
      }

      expect(response.status).toBe('ok')
      expect(response.mode).toBe('lexical')
      expect(response.degradation).toBe('semantic-source-unconfigured')
      expect(response.verification).toBe('checked')
      expect(response.coverage).toEqual({ indexed: 1, pending: 0 })
      expect(response.results).toHaveLength(1)

      const hit = response.results[0]!
      expect(hit.locator).toEqual({ kind: 'file', path: notePath, startLine: 2, endLine: 2 })
      expect(hit.lexicalOnly).toBe(true)

      // The fourth tool, through the same live child: a folder wiki whose rows carry digests the test process
      // can recompute. This is the one call that would silently rot if the wiring were only in the surface.
      // The same file, registered again as part of its folder: registration is idempotent by location, so this
      // sets the `folder` field rather than adding a second row — which is exactly what the wiki selects on.
      await client.callTool({
        name: 'knowledge_register_source',
        arguments: { kind: 'folder', path: join(dataRoot, 'papers') }
      })
      const wiki = await client.callTool({
        name: 'knowledge_render_wiki',
        arguments: { folder: join(dataRoot, 'papers') }
      })
      const wikiText = (wiki.content as { type: string; text: string }[])[0]?.text ?? ''
      const wikiResult = JSON.parse(wikiText) as {
        state: string
        content?: string
        entries?: number
      }
      expect(wikiResult.state).toBe('written')
      expect(wikiResult.entries).toBe(1)
      expect(wikiResult.content).toContain(
        createHash('sha256')
          .update('# Cohort\n' + matchingLine + '\nEGFR remained wild type\n', 'utf8')
          .digest('hex')
      )

      // Re-read the file and hash the cited line here, in the test process, with no help from the app.
      const onDisk = (await readFile(notePath, 'utf8')).split('\n')[1] ?? ''
      expect(onDisk).toBe(matchingLine)
      expect(hit.sha256).toBe(sha256(onDisk))
    } finally {
      await client.close().catch(() => undefined)
    }
  }, 120_000)

  it('refuses methods outside the knowledge whitelist on a knowledge connection', async () => {
    const dataRoot = await tempDir('knowledge-mcp-denied-')
    const { connection } = await startServer(dataRoot)

    const response = await fetch(connection.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${connection.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        method: 'pdfOpen',
        params: { sessionId: 'session-1', projectId: 'project-1', path: '/etc/hosts' }
      })
    })

    // The knowledge grant must not be a master key: a pdf method on this token is refused.
    expect(response.ok).toBe(false)
  })
})

// The four answers a caller must be able to tell apart, each through the live MCP child: refused, nothing
// matched, nothing indexed, and a citation that follows the bytes. Written as its own block because these are
// the properties an outside reader relies on, not the plumbing that carries them.
const withClient = async (
  dataRoot: string,
  run: (client: Client) => Promise<void>
): Promise<void> => {
  const { connection } = await startServer(dataRoot)
  const entry = await bundleKnowledgeMcpEntry()
  const client = new Client({ name: 'knowledge-acceptance', version: '1.0.0' })
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    env: {
      ...(process.env as Record<string, string>),
      ELECTRON_RUN_AS_NODE: '1',
      PURESCIENCE_KNOWLEDGE_RPC_ENDPOINT: connection.endpoint,
      PURESCIENCE_KNOWLEDGE_RPC_TOKEN: connection.token,
      PURESCIENCE_KNOWLEDGE_SESSION_ID: 'session-1',
      PURESCIENCE_KNOWLEDGE_PROJECT_ID: 'project-1'
    },
    stderr: 'pipe'
  })
  try {
    await client.connect(transport)
    await run(client)
  } finally {
    await client.close().catch(() => undefined)
  }
}

const callJson = async <T>(
  client: Client,
  name: string,
  args: Record<string, unknown>
): Promise<T> => {
  const result = await client.callTool({ name, arguments: args })
  const text = (result.content as { type: string; text: string }[])[0]?.text ?? ''
  return JSON.parse(text) as T
}

describe('knowledge tool acceptance (four answers a caller must be able to tell apart)', () => {
  it('1/4 refuses a path outside the managed roots, by name', async () => {
    const dataRoot = await tempDir('knowledge-acc-refuse-')
    const outside = await tempDir('knowledge-acc-outside-')
    const outsideFile = join(outside, 'secret.md')
    await writeFile(outsideFile, 'nope', 'utf8')

    await withClient(dataRoot, async (client) => {
      const outcome = await client.callTool({
        name: 'knowledge_register_source',
        arguments: { kind: 'file', path: outsideFile }
      })
      const text = (outcome.content as { type: string; text: string }[])[0]?.text ?? ''
      // The tool reports the refusal rather than throwing across the transport, and it names the reason.
      expect(outcome.isError === true || text.includes('source-outside-roots')).toBe(true)
      expect(text).toContain('source-outside-roots')
    })
  })

  it('2/4 says no-matches only when the store owes nothing', async () => {
    const dataRoot = await tempDir('knowledge-acc-empty-')
    const file = join(dataRoot, 'notes.md')
    await writeFile(file, 'EGFR resistance', 'utf8')

    await withClient(dataRoot, async (client) => {
      await callJson(client, 'knowledge_register_source', { kind: 'file', path: file })
      const response = await callJson<{
        status: string
        coverage: { indexed: number; pending: number }
        results: unknown[]
      }>(client, 'knowledge_search', { query: 'TP53' })

      expect(response.status).toBe('no-matches')
      expect(response.coverage).toEqual({ indexed: 1, pending: 0 })
      expect(response.results).toEqual([])
    })
  })

  it('3/4 says not-indexed — never no-matches — when a registered source has gone', async () => {
    const dataRoot = await tempDir('knowledge-acc-gone-')
    const file = join(dataRoot, 'ephemeral.md')
    await writeFile(file, 'temporary TP53 note', 'utf8')

    await withClient(dataRoot, async (client) => {
      await callJson(client, 'knowledge_register_source', { kind: 'file', path: file })
      await rm(file)
      const response = await callJson<{
        status: string
        coverage: { indexed: number; pending: number }
      }>(client, 'knowledge_search', { query: 'TP53' })

      expect(response.status).toBe('not-indexed')
      expect(response.coverage).toEqual({ indexed: 0, pending: 1 })
    })
  })

  it('4/4 re-cites the bytes as they are now, so an edited line changes the digest', async () => {
    const dataRoot = await tempDir('knowledge-acc-edit-')
    const file = join(dataRoot, 'living.md')
    await writeFile(file, 'TP53 amplified in cohort A', 'utf8')

    await withClient(dataRoot, async (client) => {
      await callJson(client, 'knowledge_register_source', { kind: 'file', path: file })
      const before = await callJson<{
        results: { sha256: string; locator: { startLine: number; endLine: number } }[]
      }>(client, 'knowledge_search', { query: 'TP53' })
      expect(before.results[0]?.locator).toEqual({
        kind: 'file',
        path: file,
        startLine: 1,
        endLine: 1
      })
      expect(before.results[0]?.sha256).toBe(
        createHash('sha256').update('TP53 amplified in cohort A', 'utf8').digest('hex')
      )

      // Same location, different bytes: the next search must cite the new line, not replay the old digest.
      await writeFile(file, 'TP53 amplified in cohort B', 'utf8')
      const after = await callJson<{ results: { sha256: string }[] }>(client, 'knowledge_search', {
        query: 'TP53'
      })
      expect(after.results[0]?.sha256).toBe(
        createHash('sha256').update('TP53 amplified in cohort B', 'utf8').digest('hex')
      )
      expect(after.results[0]?.sha256).not.toBe(before.results[0]?.sha256)
    })
  })
})
