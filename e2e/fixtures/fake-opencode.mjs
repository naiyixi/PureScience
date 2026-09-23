/* eslint-disable @typescript-eslint/explicit-function-return-type */

import * as acp from '@agentclientprotocol/sdk'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { appendFileSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'

const VERSION = '1.0.0'
const PERMISSION_PROMPT = 'Request fixture permission.'
const PROVIDER_BRIDGE_PROMPT = 'Verify the provider bridge.'
const NOTEBOOK_LIFECYCLE_PROMPT = 'Verify the notebook lifecycle.'
const ARTIFACT_PROVENANCE_PROMPT = 'Create a provenance artifact.'
const PDF_REGION_PROMPT = 'Create a region drawing PDF.'
const INTERRUPTED_TURN_PROMPT = 'Continue the interrupted turn fixture.'
const PARTIAL_TURN_REPLY = 'Part of the answer arrived before the app went down.'
const CONTINUED_TURN_REPLY = 'The interrupted turn continued from where it stopped.'

const sessionRoutes = new Map()

// The interrupted-turn fixture hangs on its first send of the run and answers afterwards. A restart starts a
// fresh agent process, so the fact that the turn was left open has to outlive this process: the marker file
// below is written when the turn is left hanging and read by the process that serves the continuation.
const agentLog = (line) => {
  const state = process.env.PURESCIENCE_FAKE_AGENT_STATE
  if (!state) return
  try {
    appendFileSync(state + '.log', `${new Date().toISOString()} ${line}\n`)
  } catch {
    /* logging must never break the fixture */
  }
}

// Whether this run has already left an interrupted turn hanging travels through the filesystem, because the
// agent never receives the app's environment: its backend is spawned with the config's environment. The
// session id keys it, so two runs cannot collide, and the process that answers the continuation removes it.
const interruptedTurnMarker = (sessionId) =>
  join(tmpdir(), `purescience-e2e-interrupted-turn-${sessionId}`)

const stringEnvironment = (overrides = []) => {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter((entry) => entry[1] !== undefined)
  )
  for (const entry of overrides) environment[entry.name] = entry.value
  return environment
}

const toolResult = (name, result) => {
  const text = result.content
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('\n')
  if (result.isError) throw new Error(`${name} failed: ${text}`)
  return JSON.parse(text)
}

const frameworkServerName = (name) => name.replaceAll('-', '_')

const withMcpClient = async (sessionId, serverName, operation) => {
  const route = sessionRoutes.get(sessionId)
  const server = route?.mcpServers?.find(
    (candidate) =>
      candidate.name === serverName || candidate.name === frameworkServerName(serverName)
  )
  if (!route || !server?.command) {
    const routed = route?.mcpServers?.map((candidate) => candidate.name).join(', ') || 'none'
    throw new Error(`${serverName} was not routed to ${sessionId}; routed servers: ${routed}.`)
  }

  const transport = new StdioClientTransport({
    command: server.command,
    args: server.args ?? [],
    cwd: route.cwd,
    env: stringEnvironment(server.env)
  })
  const client = new Client({ name: 'purescience-e2e-agent', version: VERSION })
  await client.connect(transport)
  try {
    return await operation(client)
  } finally {
    await client.close()
  }
}

const verifyProviderBridge = () => {
  const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? '{}')
  const providers = Object.values(config.provider ?? {})
  const route = providers.find((provider) => provider?.models?.['e2e-model'])
  const credentialName = route?.options?.apiKey?.match(/^\{env:([^}]+)\}$/)?.[1]
  const credential = credentialName ? process.env[credentialName] : undefined
  if (!route?.options?.baseURL || !credential)
    throw new Error('The persisted provider route did not reach the Agent process.')
  const direct = route.options.baseURL === 'http://127.0.0.1:9/v1' && credential === 'e2e-key'
  const url = new URL(route.options.baseURL)
  const bridged = url.hostname === '127.0.0.1' && url.pathname === '/v1' && url.port !== '9'
  if (!direct && !bridged)
    throw new Error(
      `The persisted provider route did not reach the Agent process ` +
        `(base URL: ${route.options.baseURL}, credential: present).`
    )
  return 'Provider bridge verified through the Agent process.'
}

const verifyNotebookLifecycle = async (sessionId) =>
  withMcpClient(sessionId, 'purescience-notebook', async (client) => {
    const initial = toolResult(
      'notebook_state',
      await client.callTool({ name: 'notebook_state', arguments: {} })
    )
    const execution = toolResult(
      'bash_execute',
      await client.callTool({
        name: 'bash_execute',
        arguments: { command: 'node -e "console.log(\'notebook-lifecycle-e2e\')"' }
      })
    )
    const after = toolResult(
      'notebook_state',
      await client.callTool({ name: 'notebook_state', arguments: {} })
    )
    const shutdown = toolResult(
      'notebook_shutdown',
      await client.callTool({ name: 'notebook_shutdown', arguments: {} })
    )
    if (
      initial.sessionId !== after.sessionId ||
      !execution.stdout?.includes('notebook-lifecycle-e2e') ||
      shutdown.status !== 'shutdown'
    ) {
      throw new Error('The Notebook lifecycle did not preserve its session and output.')
    }
    return `Notebook lifecycle verified for ${initial.sessionId}.`
  })

const createProvenanceArtifact = async (sessionId) => {
  const producerRunId = await withMcpClient(sessionId, 'purescience-notebook', async (client) => {
    const execution = toolResult(
      'bash_execute',
      await client.callTool({
        name: 'bash_execute',
        arguments: { command: 'node -e "console.log(\'artifact-provenance-e2e\')"' }
      })
    )
    const state = toolResult(
      'notebook_state',
      await client.callTool({ name: 'notebook_state', arguments: {} })
    )
    const run = state.recentRuns
      ?.toReversed()
      .find(
        (candidate) =>
          candidate.kernelKind === 'bash' &&
          candidate.status === 'completed' &&
          candidate.outputPreview?.includes('artifact-provenance-e2e')
      )
    if (!execution.stdout?.includes('artifact-provenance-e2e') || !run?.runId) {
      throw new Error('The Notebook did not persist the Bash producer run.')
    }
    return run.runId
  })
  const stored = await withMcpClient(sessionId, 'purescience-artifacts', async (client) =>
    toolResult(
      'write_artifact_file',
      await client.callTool({
        name: 'write_artifact_file',
        arguments: {
          filename: 'provenance-evidence.txt',
          mimeType: 'text/plain',
          content: 'artifact provenance e2e',
          encoding: 'utf8',
          producerRunId
        }
      })
    )
  )
  if (!stored.artifact?.version_id || stored.artifact.producer_run_id !== producerRunId) {
    throw new Error('The artifact Version did not retain its Notebook producer run.')
  }
  return `Artifact provenance verified for session ${sessionId}, artifact ${stored.artifact.artifact_id}, version ${stored.artifact.version_id}.`
}

// A one-page PDF, built by hand so the fixture depends on no generator: pdf.js needs a catalog, one page
// with a font and a content stream, and an xref table whose offsets are correct — which is exactly what
// computing the offsets here guarantees. The page carries a picture and a caption under it, so the figure
// extraction has something real to find: a 2x2 image painted at 200x150 points and "Figure 1." below it.
const minimalPdf = (text) => {
  // 2x2 RGB image samples, then the page content: paint the image, then write the caption under it.
  const imageData = Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0])
  const imageBytes = [...imageData].map((byte) => String.fromCharCode(byte)).join('')
  const content =
    `q 200 0 0 150 100 500 cm /Im1 Do Q\n` +
    `BT /F1 18 Tf 40 320 Td (${text}) Tj ET\n` +
    'BT /F1 12 Tf 100 470 Td (Figure 1. Measured response) Tj ET'
  const objects = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 400 600]/Resources<</Font<</F1 4 0 R>>/XObject<</Im1 6 0 R>>>>/Contents 5 0 R>>',
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
    `<</Length ${content.length}>>stream\n${content}\nendstream`,
    `<</Type/XObject/Subtype/Image/Width 2/Height 2/ColorSpace/DeviceRGB/BitsPerComponent 8/Length ${imageData.length}>>stream\n${imageBytes}\nendstream`
  ]
  let body = '%PDF-1.4\n'
  const offsets = []
  objects.forEach((object, index) => {
    offsets.push(body.length)
    body += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xref = body.length
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) body += `${String(offset).padStart(10, '0')} 00000 n \n`
  body += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(body, 'latin1').toString('base64')
}

const createPdfRegionArtifact = async (sessionId) =>
  withMcpClient(sessionId, 'purescience-artifacts', async (client) => {
    const stored = toolResult(
      'write_artifact_file',
      await client.callTool({
        name: 'write_artifact_file',
        arguments: {
          filename: 'region-evidence.pdf',
          mimeType: 'application/pdf',
          encoding: 'base64',
          content: minimalPdf('Region evidence')
        }
      })
    )
    if (!stored.artifact?.artifact_id || !stored.artifact.version_id) {
      throw new Error('The PDF artifact was not stored with a Version.')
    }
    return `Region PDF ready for session ${sessionId}, artifact ${stored.artifact.artifact_id}, version ${stored.artifact.version_id}.`
  })

if (process.argv.includes('--version')) {
  process.stdout.write(`${VERSION}\n`)
} else {
  let nextMessageId = 1
  let nextSessionId = 1

  const app = acp
    .agent({ name: 'purescience-e2e-agent' })
    .onRequest(acp.methods.agent.initialize, () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
        sessionCapabilities: { close: {}, resume: {} }
      },
      authMethods: []
    }))
    .onRequest(acp.methods.agent.authenticate, () => ({}))
    .onRequest(acp.methods.agent.session.new, (context) => {
      const sessionId = `e2e-session-${nextSessionId++}`
      sessionRoutes.set(sessionId, {
        cwd: context.params.cwd,
        mcpServers: context.params.mcpServers ?? []
      })
      return { sessionId }
    })
    .onRequest(acp.methods.agent.session.resume, (context) => {
      sessionRoutes.set(context.params.sessionId, {
        cwd: context.params.cwd,
        mcpServers: context.params.mcpServers ?? []
      })
      return {}
    })
    .onRequest(acp.methods.agent.session.prompt, async (context) => {
      const prompt = context.params.prompt
        .map((content) => (content.type === 'text' ? content.text : ''))
        .join('')

      let reply = 'Deterministic reply: Summarize the deterministic fixture.'
      // The interrupted-turn fixture: the first send is never answered, so the spec can restart the
      // app while the turn is genuinely in flight. The continuation that arrives after the restart is
      // answered, and that answer is what the spec looks for.
      if (prompt.includes(INTERRUPTED_TURN_PROMPT)) {
        const marker = interruptedTurnMarker(context.params.sessionId)
        agentLog(`interrupted prompt pid=${process.pid} marker=${existsSync(marker)} at ${marker}`)
        if (!existsSync(marker)) {
          // Say something first, so this turn is visibly in flight, then write the marker and never finish:
          // the app is restarted while the turn is open, which is the interruption under test. The next
          // process to see this prompt is serving the continuation, and answers it.
          await context.client.notify(acp.methods.client.session.update, {
            sessionId: context.params.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              messageId: 'e2e-interrupted-turn',
              content: { type: 'text', text: PARTIAL_TURN_REPLY }
            }
          })
          writeFileSync(marker, PARTIAL_TURN_REPLY)
          return new Promise(() => {})
        }
        // The continuation is being served: the run is over as far as this marker is concerned.
        rmSync(marker, { force: true })
        reply = CONTINUED_TURN_REPLY
      }
      agentLog(`prompt from session ${context.params.sessionId}: ${prompt.slice(0, 90)}`)
      try {
        if (prompt.includes(PROVIDER_BRIDGE_PROMPT)) {
          reply = verifyProviderBridge()
        } else if (prompt.includes(NOTEBOOK_LIFECYCLE_PROMPT)) {
          reply = await verifyNotebookLifecycle(context.params.sessionId)
        } else if (prompt.includes(ARTIFACT_PROVENANCE_PROMPT)) {
          reply = await createProvenanceArtifact(context.params.sessionId)
        } else if (prompt.includes(PDF_REGION_PROMPT)) {
          reply = await createPdfRegionArtifact(context.params.sessionId)
        } else if (prompt.includes(PERMISSION_PROMPT)) {
          const permission = await context.client.request(
            acp.methods.client.session.requestPermission,
            {
              sessionId: context.params.sessionId,
              toolCall: {
                toolCallId: 'e2e-permission-tool',
                title: 'Write fixture output'
              },
              options: [
                { kind: 'allow_once', name: 'Allow once', optionId: 'allow-once' },
                { kind: 'reject_once', name: 'Deny', optionId: 'deny-once' }
              ]
            }
          )
          reply =
            permission.outcome.outcome === 'selected' &&
            permission.outcome.optionId === 'allow-once'
              ? 'Fixture permission allowed.'
              : 'Fixture permission denied.'
        }
      } catch (error) {
        reply = `E2E fixture failure: ${error instanceof Error ? error.message : String(error)}`
      }

      await context.client.notify(acp.methods.client.session.update, {
        sessionId: context.params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: `e2e-message-${nextMessageId++}`,
          content: { type: 'text', text: reply }
        }
      })

      return { stopReason: 'end_turn' }
    })
    .onNotification(acp.methods.agent.session.cancel, () => undefined)
    .onRequest(acp.methods.agent.session.close, () => ({}))

  const connection = app.connect(
    acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin))
  )
  await connection.closed
}
