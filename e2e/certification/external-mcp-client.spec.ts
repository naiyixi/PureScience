import { expect } from '@playwright/test'
import { execFile } from 'node:child_process'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

import { EXTERNAL_MCP_TOOLS } from '../../src/main/external-mcp/surface'
import { normalizeSessionFile } from '../../src/shared/session-persistence'
import { test } from '../fixtures/electron-app'
import { createProject, openRecentSession, sendPrompt } from './helpers'

// F1 true-machine reading: an outside MCP client, in its own process, reading this machine through
// `purescience mcp`.
//
// The unit suites assert the tool table, the projections and the refusals; they cannot show that a
// *separate program* — the situation the feature exists for — can reach a *running* app. This spec starts
// the real CLI as a child process and speaks MCP to it over stdio with the SDK's client, exactly as a
// desktop assistant would, so the three properties that matter are observed from the outside:
//
//   1. `tools/list` is the declared table, tool for tool (not "some tools are exposed").
//   2. A read tool returns data that matches what is on disk for this isolated root — the session id the
//      client receives is the id of the file the app wrote.
//   3. Every call leaves one `external mcp call` line in the app's own log, with the outcome — the
//      operational counterpart of the broker's audit line.
//
// The refusal is exercised too: an unknown session id must come back as a named refusal, not as an empty
// result a client could mistake for a conversation with no messages.

const CLI_PATH = resolve(process.cwd(), 'packages', 'purescience', 'cli.mjs')

test.setTimeout(240_000)

type ToolPayload = Record<string, unknown>

// The SDK's result type is a union that also covers task-shaped results; every tool here answers with text
// content, so read that one member and let the assertion below fail loudly if it is ever absent.
const payloadOf = (result: unknown): ToolPayload => {
  const value = result as { content?: { type?: string; text?: string }[] }
  const content = Array.isArray(value.content) ? value.content : []
  const text = content.map((entry) => entry.text ?? '').join('')
  return JSON.parse(text) as ToolPayload
}

const execFileAsync = promisify(execFile)

// The CLI is driven as a separate process, the way a headless operator drives it: the configuration root
// is this launch's, so it can only see this app.
const runCli = async (storageRoot: string, args: string[]): Promise<unknown> => {
  const { stdout } = await execFileAsync(
    process.execPath,
    [CLI_PATH, ...args, '--config-root', storageRoot, '--json'],
    { maxBuffer: 8 * 1024 * 1024 }
  )
  return JSON.parse(stdout) as unknown
}

// The app's logger mirrors each record to the console as `[scope] msg { … }` in Node's inspector form,
// which wraps a long object over several lines. Strip the colour escapes before reading fields, or every
// field looks absent while plainly being there. The pattern is built from a code point rather than a
// literal control character, which the repository's lint rules reject.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')
const stripAnsi = (text: string): string => text.replace(ANSI, '')
const fieldOf = (text: string, field: string): string | undefined =>
  new RegExp(`\\b${field}: '([^']*)'`).exec(text)?.[1] ??
  new RegExp(`\\b${field}: (true|false|\\d+)`).exec(text)?.[1]

// One block per log record carrying `needle`: from its opening line to the line that closes the object.
const logBlocks = (log: string, needle: string): string[] => {
  const lines = log.split('\n')
  const blocks: string[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string
    if (!line.includes(needle)) continue
    const block: string[] = [line]
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const next = lines[cursor] as string
      block.push(next)
      if (next.trim() === '}') break
    }
    blocks.push(stripAnsi(block.join('\n')))
  }
  return blocks
}

test('an outside client reads this machine through the CLI and every call leaves one log line', async ({
  app
}) => {
  await app.completeOnboarding()
  const page = await app.configureFakeAgent()
  await createProject(page, 'External MCP')
  // The fixture agent answers this default text for any prompt it does not special-case; the reply has to be
  // the fixture's own wording, or this would be waiting for something no agent ever says.
  await sendPrompt(
    page,
    'First question',
    'Deterministic reply: Summarize the deterministic fixture.',
    90_000
  )

  // What the app wrote, read from the disk by this test rather than asked of the app: the client's answer
  // has to agree with it.
  //
  // Waited for rather than sampled once: the reply is on screen before the durable document is written (the
  // same ordering that made an earlier certification spec read 3 messages while the archive had 4), so the
  // first read after a turn can legitimately still hold only the question.
  // `PURESCIENCE_E2E_STORAGE_ROOT` pins the data root at `<storage>/PureScience-DEV`, and sessions live
  // inside the data root; both layouts are scanned rather than assumed, because a development build has
  // been observed deriving the data folder and a spec that guesses one path silently finds nothing.
  const sessionsRoots = [
    join(app.storageRoot, 'PureScience-DEV', 'sessions'),
    join(app.storageRoot, 'sessions')
  ]
  type StoredSession = { id: string; projectId: string; messageCount: number }
  const readSessionsFromDisk = async (): Promise<StoredSession[]> => {
    const found: StoredSession[] = []
    for (const sessionsRoot of sessionsRoots) {
      if (!(await stat(sessionsRoot).catch(() => undefined))?.isDirectory()) continue
      for (const directory of await readdir(sessionsRoot, { withFileTypes: true })) {
        if (!directory.isDirectory()) continue
        const files = await readdir(join(sessionsRoot, directory.name), { withFileTypes: true })
        for (const file of files) {
          if (!file.isFile() || !file.name.endsWith('.json')) continue
          // The writer publishes atomically through `*.tmp`; a half-written file is not a document.
          if (file.name.endsWith('.tmp')) continue
          // `<id>.json` sits beside `<id>.json.summary.json`, a projection without the document's own id.
          if (file.name.endsWith('.summary.json')) continue
          // Read it the way the app reads it. A durable file stores the conversation as a graph and drops
          // the flat `messages` array (the writer omits it deliberately — the reader rebuilds it), so a
          // hand-rolled `document.session.messages.length` counts nothing and looks like an unsaved turn.
          const document = normalizeSessionFile(
            JSON.parse(await readFile(join(sessionsRoot, directory.name, file.name), 'utf8'))
          )
          if (!document) continue
          found.push({
            id: document.id,
            projectId: directory.name,
            messageCount: document.messages?.length ?? 0
          })
        }
      }
    }
    return found
  }
  console.log(
    `[f1] disk scan roots=${JSON.stringify(sessionsRoots)} found=${JSON.stringify(await readSessionsFromDisk())}`
  )
  let onDisk: StoredSession[] = []
  await expect
    .poll(
      async () => {
        onDisk = await readSessionsFromDisk()
        return onDisk[0]?.messageCount ?? 0
      },
      { timeout: 60_000, message: 'the turn settles into the durable session document' }
    )
    .toBeGreaterThanOrEqual(2)
  const stored = onDisk[0] as StoredSession

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI_PATH, 'mcp', '--config-root', app.storageRoot],
    // The CLI must find the app by itself; stderr is kept on the parent's so a start-up refusal is visible
    // in the Playwright output instead of vanishing.
    stderr: 'inherit'
  })
  const client = new Client({ name: 'purescience-certification-client', version: '1.0.0' })
  await client.connect(transport)

  try {
    // 1. The declared table, tool for tool.
    const listed = await client.listTools()
    const names = listed.tools.map((tool) => tool.name).sort()
    const declared = EXTERNAL_MCP_TOOLS.map((tool) => tool.id).sort()
    console.log(`[f1] tools/list: ${JSON.stringify(names)}`)
    expect(names).toEqual(declared)
    for (const tool of listed.tools) {
      const source = EXTERNAL_MCP_TOOLS.find((entry) => entry.id === tool.name)
      expect(source).toBeDefined()
      // The outside model reads these; a mismatch would mean the served schema is not the audited one.
      expect(tool.description).toBe(source?.description)
      expect(tool.inputSchema).toEqual(source?.inputSchema as never)
    }

    // 2. Real data, agreeing with the disk.
    const projects = payloadOf(await client.callTool({ name: 'list_projects', arguments: {} }))
    console.log(`[f1] list_projects: ${JSON.stringify(projects)}`)
    const projectRows = (projects.projects ?? []) as { id: string; name: string }[]
    const project = projectRows.find((row) => row.id === stored.projectId)
    expect(project).toBeDefined()

    const sessions = payloadOf(
      await client.callTool({
        name: 'list_sessions',
        arguments: { project: stored.projectId }
      })
    )
    const sessionRows = (sessions.sessions ?? []) as { id: string; messageCount: number }[]
    console.log(`[f1] list_sessions: ${JSON.stringify(sessionRows)}`)
    const listedSession = sessionRows.find((row) => row.id === stored.id)
    expect(listedSession).toBeDefined()

    const conversation = payloadOf(
      await client.callTool({ name: 'read_session', arguments: { sessionId: stored.id } })
    )
    console.log(`[f1] read_session: ${JSON.stringify(conversation)}`)
    expect(conversation.sessionId).toBe(stored.id)
    expect(conversation.projectId).toBe(stored.projectId)
    expect(Number(conversation.messageCount)).toBeGreaterThan(0)
    const messages = (conversation.messages ?? []) as { role: string; content: string }[]
    const text = messages.map((message) => message.content).join('\n')
    expect(text).toContain('First question')
    expect(text).toContain('Deterministic reply')
    // The excerpt states its own completeness instead of leaving the client to guess.
    expect(conversation.truncated).toBe(false)
    expect(conversation.messagesReturned).toBe(conversation.messageCount)

    const files = payloadOf(
      await client.callTool({
        name: 'list_project_files',
        arguments: { project: stored.projectId }
      })
    )
    console.log(`[f1] list_project_files: ${JSON.stringify(files)}`)
    expect(files.projectId).toBe(stored.projectId)

    // 3. A refusal is named, not an empty answer.
    const refused = await client.callTool({
      name: 'read_session',
      arguments: { sessionId: 'no-such-session' }
    })
    const refusal = payloadOf(refused)
    console.log(`[f1] refusal: ${JSON.stringify(refusal)}`)
    expect(refused.isError).toBe(true)
    expect((refusal.error as { code?: string }).code).toBe('session-not-found')
  } finally {
    await client.close()
  }

  // 4. One line per call — the reading that makes an outside client's reach auditable.
  //
  // Read from this launch's own captured output rather than `~/Library/Logs/…/main.log`: that file is shared
  // with the developer's instance, so a line found there could belong to another process. The logger mirrors
  // each record to the console as `[scope] msg { … }` (Node's inspected form, not JSON), which is what the
  // harness captures per launch.
  const logPath = app.currentLaunchLogPath
  expect(logPath).toBeDefined()
  const log = await readFile(logPath as string, 'utf8')
  const callLines = logBlocks(log, 'external mcp call').map((text) => ({
    line: text.replace(/\s+/g, ' ').trim(),
    tool: fieldOf(text, 'tool'),
    outcome: fieldOf(text, 'outcome'),
    code: fieldOf(text, 'code'),
    risk: fieldOf(text, 'risk'),
    durationMs: fieldOf(text, 'durationMs'),
    toolCallId: fieldOf(text, 'toolCallId')
  }))
  console.log(`[f1] call lines: ${JSON.stringify(callLines.map((entry) => entry.line))}`)
  const okTools = callLines
    .filter((line) => line.outcome === 'ok')
    .map((line) => line.tool)
    .sort()
  expect(okTools).toEqual(
    ['list_project_files', 'list_projects', 'list_sessions', 'read_session'].sort()
  )
  const refusedLine = callLines.find((line) => line.code === 'session-not-found')
  expect(refusedLine).toBeDefined()
  expect(refusedLine?.outcome).toBe('refused')
  // Every line carries the tool's risk, a duration and the id that pairs it with anything downstream: the
  // fields an audit needs.
  for (const line of callLines) {
    expect(line.risk).toBe('read')
    expect(Number(line.durationMs)).toBeGreaterThanOrEqual(0)
    expect(line.toolCallId).toBeTruthy()
  }
})

// F1 second slice, true-machine reading: the one write tool, and the gate in front of it.
//
// The unit suites assert the gate's branches against a stub port; they cannot show that a *separate
// program*'s write reaches *this* app's real approval card, that the answer decides whether the change
// happens, and that the two records of it (the broker's `permission decision` and the server's
// `external mcp call`) can be joined. All three are observed here from outside the app:
//
//   1. Declined: a named `not-approved` refusal, and the conversation is still in the default list.
//   2. Approved: the tool returns the archive it performed, and `list_sessions` now reports it archived —
//      a write whose effect its own author can read back.
//   3. One `permission decision` line per ask (isMcp, the client's tool, decision `card`) sharing the
//      `toolCallId` of the `external mcp call` line that asked.
//
// The card is answered through the CLI (`purescience permissions` / `approve`), which is also the only way
// to answer it in a headless service: the window shows cards for the conversation it is displaying, and a
// write whose target is not on screen has to be answerable from a terminal or not at all.
test('an outside client’s write waits on the app’s own card, and a refusal leaves the data alone', async ({
  app
}) => {
  await app.completeOnboarding()
  let page = await app.configureFakeAgent()
  await createProject(page, 'External MCP Write')
  await sendPrompt(
    page,
    'First question',
    'Deterministic reply: Summarize the deterministic fixture.',
    90_000
  )

  // The card is answered through the CLI, which needs the app to publish where it listens
  // (`web-service.json` + `web-token` in the config root — what `purescience start` always writes). This
  // launch is given a port so it publishes one; the variable is cleared immediately after the relaunch so it
  // cannot leak into another spec in this worker.
  process.env.PURESCIENCE_WEB_PORT = '0'
  try {
    page = await app.restart()
  } finally {
    delete process.env.PURESCIENCE_WEB_PORT
  }
  // The card is parked on the conversation the write changes, and the window renders cards for the
  // conversation it is showing — so the target is reopened here, exactly as a reader would have it before
  // answering an outside client's request.
  await openRecentSession(page, 'First question')
  await expect(page.getByText('Deterministic reply', { exact: false })).toBeVisible({
    timeout: 60_000
  })

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI_PATH, 'mcp', '--config-root', app.storageRoot],
    stderr: 'inherit'
  })
  const client = new Client({ name: 'purescience-certification-writer', version: '1.0.0' })
  await client.connect(transport)

  type SessionRow = { id: string; messageCount?: number; archived?: string }
  type PendingCard = {
    requestId: string
    sessionId?: string
    title?: string
    isMcp?: boolean
    toolCallId?: string
    options?: { optionId: string; kind?: string }[]
  }
  const listedSessions = async (): Promise<SessionRow[]> => {
    const payload = payloadOf(await client.callTool({ name: 'list_sessions', arguments: {} }))
    return (payload.sessions ?? []) as SessionRow[]
  }

  try {
    // The target comes from the app's own list rather than from a guessed path: the client archives the
    // conversation the app says it has, with at least the question and the reply in it.
    let target: SessionRow | undefined
    await expect
      .poll(
        async () => {
          target = (await listedSessions()).find((row) => (row.messageCount ?? 0) >= 2)
          return target?.id ?? ''
        },
        { timeout: 60_000, message: 'the turn appears in the list the client reads' }
      )
      .not.toBe('')
    const sessionId = (target as SessionRow).id
    console.log(`[f1-write] target session: ${sessionId}`)

    // The card, as the app publishes it to a headless caller. Polled because the card appears only once the
    // call reaches the broker, which is after the plan resolved its target.
    const waitForCard = async (): Promise<PendingCard> => {
      let card: PendingCard | undefined
      await expect
        .poll(
          async () => {
            const pending = (await runCli(app.storageRoot, ['permissions'])) as PendingCard[]
            card = (Array.isArray(pending) ? pending : []).find((entry) => entry.isMcp === true)
            return card?.requestId ?? ''
          },
          { timeout: 45_000, message: 'the write is parked on the app’s approval card' }
        )
        .not.toBe('')
      return card as PendingCard
    }

    // 1. Declined. The card is parked on the conversation the write changes — the window only renders cards
    //    for the conversation it is showing — and it names that conversation rather than a bare id.
    const declinedCall = client.callTool({ name: 'archive_session', arguments: { sessionId } })
    const declinedCard = await waitForCard()
    console.log(`[f1-write] declined card: ${JSON.stringify(declinedCard)}`)
    expect(declinedCard.sessionId).toBe(sessionId)
    expect(String(declinedCard.title)).toContain('archive')
    await runCli(app.storageRoot, ['approve', declinedCard.requestId, '--cancel'])
    const declined = await declinedCall
    const declinedPayload = payloadOf(declined)
    console.log(`[f1-write] declined: ${JSON.stringify(declinedPayload)}`)
    expect(declined.isError).toBe(true)
    expect((declinedPayload.error as { code?: string }).code).toBe('not-approved')
    expect((await listedSessions()).find((row) => row.id === sessionId)?.archived).toBeUndefined()

    // 2. Approved. Approved through the option the card itself offers, so the answer is the one a reader
    //    would click rather than an id this test made up.
    const approvedCall = client.callTool({ name: 'archive_session', arguments: { sessionId } })
    const approvedCard = await waitForCard()
    console.log(`[f1-write] approved card: ${JSON.stringify(approvedCard)}`)
    const approveOption = approvedCard.options?.find(
      (option) => option.kind === 'allow_once'
    )?.optionId
    expect(approveOption).toBeDefined()
    await runCli(app.storageRoot, [
      'approve',
      approvedCard.requestId,
      '--option',
      String(approveOption)
    ])
    const approved = await approvedCall
    const approvedPayload = payloadOf(approved)
    console.log(`[f1-write] approved: ${JSON.stringify(approvedPayload)}`)
    expect(approved.isError).toBeFalsy()
    expect(approvedPayload.sessionId).toBe(sessionId)
    expect(approvedPayload.archived).toBe(true)
    expect(typeof approvedPayload.archivedAt).toBe('number')

    // The write's effect is readable through the read tier: without `archived` on the row, a client could
    // archive a conversation and its next list would look identical.
    const archivedRow = (await listedSessions()).find((row) => row.id === sessionId)
    expect(archivedRow?.archived).toBeDefined()
    expect(Number.isNaN(Date.parse(String(archivedRow?.archived)))).toBe(false)

    // 3. The two records, joined by the id the caller was given.
    const logPath = app.currentLaunchLogPath
    expect(logPath).toBeDefined()
    const log = await readFile(logPath as string, 'utf8')
    const decisions = logBlocks(log, 'permission decision')
      .map((text) => ({
        line: text.replace(/\s+/g, ' ').trim(),
        toolCallId: fieldOf(text, 'toolCallId'),
        decision: fieldOf(text, 'decision'),
        isMcp: fieldOf(text, 'isMcp'),
        tool: fieldOf(text, 'tool'),
        sessionId: fieldOf(text, 'sessionId')
      }))
      .filter(
        (entry) => entry.isMcp === 'true' && entry.tool === 'purescience_external/archive_session'
      )
    console.log(`[f1-write] permission decision lines: ${JSON.stringify(decisions)}`)
    expect(decisions).toHaveLength(2)
    for (const entry of decisions) {
      // `card` is the point: this path cannot auto-approve, whatever profile the app's own agent runs on.
      expect(entry.decision).toBe('card')
      expect(entry.sessionId).toBe(sessionId)
      expect(entry.toolCallId).toBeTruthy()
    }

    const writeCalls = logBlocks(log, 'external mcp call')
      .map((text) => ({
        line: text.replace(/\s+/g, ' ').trim(),
        tool: fieldOf(text, 'tool'),
        outcome: fieldOf(text, 'outcome'),
        code: fieldOf(text, 'code'),
        risk: fieldOf(text, 'risk'),
        decision: fieldOf(text, 'decision'),
        toolCallId: fieldOf(text, 'toolCallId')
      }))
      .filter((entry) => entry.tool === 'archive_session')
    console.log(`[f1-write] archive call lines: ${JSON.stringify(writeCalls)}`)
    expect(writeCalls).toHaveLength(2)
    const declinedLine = writeCalls.find((entry) => entry.code === 'not-approved')
    const approvedLine = writeCalls.find((entry) => entry.outcome === 'ok')
    expect(declinedLine?.decision).toBe('declined')
    expect(approvedLine?.decision).toBe('approved')
    // Two facts that must not be told in different vocabularies: the call line's risk says this was a write
    // (so a reader can tell approved writes from reads), and both lines carry an id that appears in the
    // broker's own record.
    for (const line of writeCalls) expect(line.risk).toBe('write')
    expect(decisions.map((entry) => entry.toolCallId).sort()).toEqual(
      [declinedLine?.toolCallId, approvedLine?.toolCallId].sort()
    )
  } finally {
    await client.close()
  }
})
