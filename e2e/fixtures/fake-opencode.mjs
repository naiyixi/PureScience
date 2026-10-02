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
const PDF_TABLE_PROMPT = 'Create a table PDF fixture.'
const PDF_PROSE_PROMPT = 'Create a prose PDF fixture.'
const PDF_ROTATED_TABLE_PROMPT = 'Create a rotated table PDF fixture.'
const PDF_REGION_PROMPT = 'Create a region drawing PDF.'
const PDF_ANNOTATED_PROMPT = 'Create an annotated PDF fixture.'
const INTERRUPTED_TURN_PROMPT = 'Continue the interrupted turn fixture.'
// Literature screening: the app asks this agent to screen ONE record per session. The fixture answers in
// the shape the app's guardrails demand (a citation of an inclusion criterion, or an explicit
// counter-evidence passage for an exclusion), so the real prompt assembly, parse and ledger write run.
const SCREENING_PROMPT_MARKER = 'You screen ONE bibliographic record'
const SCREENING_EXCLUDE_MARKER = 'Please exclude me'
const PARTIAL_TURN_REPLY = 'Part of the answer arrived before the app went down.'
const CONTINUED_TURN_REPLY = 'The interrupted turn continued from where it stopped.'

const sessionRoutes = new Map()

// Reads the criteria the prompt declared, so the fixture cites a criterion id that really exists — an
// invented id would be discarded by the guardrails and the record would come back as uncertain.
const screeningCriteria = (prompt) => {
  const inclusion = []
  const exclusion = []
  let zone = null
  for (const line of prompt.split('\n')) {
    if (line.startsWith('## Inclusion criteria')) {
      zone = inclusion
      continue
    }
    if (line.startsWith('## Exclusion criteria')) {
      zone = exclusion
      continue
    }
    if (line.startsWith('## ')) zone = null
    const match = /^- ([^:]+): (.+)$/.exec(line)
    if (match && zone) zone.push(match[1].trim())
  }
  return { inclusion, exclusion }
}

// One record, one answer. A title carrying the exclusion marker is answered with counter-evidence (the
// only shape an exclusion survives); everything else is included on the first inclusion criterion.
const screeningReply = (prompt) => {
  const { inclusion, exclusion } = screeningCriteria(prompt)
  const title = /^Title: (.+)$/m.exec(prompt)?.[1] ?? 'the record'
  if (prompt.includes(SCREENING_EXCLUDE_MARKER)) {
    return JSON.stringify({
      verdict: 'excluded',
      probabilities: { include: 0.02, exclude: 0.95, uncertain: 0.03 },
      citations: [],
      refutation: {
        criterionId: exclusion[0] ?? 'e-1',
        quote: 'This article is a systematic review and reports no primary data.'
      }
    })
  }
  return JSON.stringify({
    verdict: 'included',
    probabilities: { include: 0.86, exclude: 0.04, uncertain: 0.1 },
    citations: [{ criterionId: inclusion[0] ?? 'i-1', quote: `Title: ${title}` }],
    refutation: null
  })
}

// The interrupted-turn fixture hangs on its first send of the run and answers afterwards. A restart starts a
// fresh agent process, so the fact that the turn was left open has to outlive this process: the marker file
// below is written when the turn is left hanging and read by the process that serves the continuation.
// The app spawns this agent with the configuration's environment rather than its own, so the log cannot be
// keyed by a variable the app sets. It goes to one path in the temp directory instead, cleared per run.
const agentLogPath = () => join(tmpdir(), 'purescience-e2e-agent.log')
const agentLog = (line) => {
  try {
    appendFileSync(agentLogPath(), `${new Date().toISOString()} pid=${process.pid} ${line}\n`)
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
// One page whose content is given: the object layout is shared so every PDF this fixture writes can be read
// the same way. The image is still referenced by the page whether or not the content paints it.
// `annotationObjects` are appended as objects 7..N and referenced from the page's own /Annots, so a PDF
// this fixture writes can carry markup inside itself — which is what the annotation import reads.
const pdfFromContent = (content, annotationObjects = [], mediaBox = '[0 0 400 600]') => {
  const imageData = Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0])
  const imageBytes = [...imageData].map((byte) => String.fromCharCode(byte)).join('')
  const annots =
    annotationObjects.length > 0
      ? `/Annots[${annotationObjects.map((_, index) => `${7 + index} 0 R`).join(' ')}]`
      : ''
  const objects = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    `<</Type/Page/Parent 2 0 R/MediaBox${mediaBox}${annots}/Resources<</Font<</F1 4 0 R>>/XObject<</Im1 6 0 R>>>>/Contents 5 0 R>>`,
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
    `<</Length ${content.length}>>stream\n${content}\nendstream`,
    `<</Type/XObject/Subtype/Image/Width 2/Height 2/ColorSpace/DeviceRGB/BitsPerComponent 8/Length ${imageData.length}>>stream\n${imageBytes}\nendstream`,
    ...annotationObjects
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

// Paint the image, then write the caption under it.
const minimalPdfContent = (text) =>
  `q 200 0 0 150 100 500 cm /Im1 Do Q\n` +
  `BT /F1 18 Tf 40 320 Td (${text}) Tj ET\n` +
  'BT /F1 12 Tf 100 470 Td (Figure 1. Measured response) Tj ET'

const minimalPdf = (text) => pdfFromContent(minimalPdfContent(text))

// One page whose caption carries two annotations the file itself wrote: a highlight over the caption
// (which the app imports, quoting the passage) and an ink stroke (a kind this build does not place, so
// the import report has to name it with its reason and count rather than quietly dropping it).
const annotatedPdf = () =>
  pdfFromContent(minimalPdfContent('Annotated evidence'), [
    '<</Type/Annot/Subtype/Highlight/F 4/C[1 1 0]/Rect[100 468 250 482]/QuadPoints[100 482 250 482 100 470 250 470]/Contents(Keep this: the effect is large)>>',
    '<</Type/Annot/Subtype/Ink/F 4/Rect[300 300 340 340]/InkList[[300 300 340 340]]/Contents(drawn stroke)>>'
  ])

// A table that is really a table: four columns and four rows, each cell placed by its own text matrix, so
// the columns are the reader's to find by position rather than by guessing from spacing.
const FIXTURE_TABLE_ROWS = [
  ['Sample', 'Value', 'sd', 'n'],
  ['control', '12.4', '1.1', '6'],
  ['treated', '31.8', '2.4', '6'],
  ['vehicle', '9.7', '0.8', '6']
]
const FIXTURE_TABLE_COLUMN_X = [40, 150, 250, 330]
// Inside the page's own box (400x600): text placed outside the media box is not read at all, so a table
// written above the page would look like a document with no text in it.
const FIXTURE_TABLE_ROW_Y = [520, 500, 480, 460]

const tablePdf = () => {
  const lines = ['BT /F1 12 Tf']
  FIXTURE_TABLE_ROWS.forEach((row, rowIndex) => {
    row.forEach((cell, columnIndex) => {
      lines.push(
        `1 0 0 1 ${FIXTURE_TABLE_COLUMN_X[columnIndex]} ${FIXTURE_TABLE_ROW_Y[rowIndex]} Tm (${cell}) Tj`
      )
    })
  })
  lines.push('ET')
  return pdfFromContent(lines.join('\n'))
}

// A page of prose: one column of plain sentences and nothing else. Its rows are above the row floor, so
// the only gate it can fail is the column floor — which is what makes it the fixture for the panel's
// "why no table was reported" line: the reason has to arrive with the counts the decision used, not as an
// unexplained empty result.
const FIXTURE_PROSE_LINES = [
  'Samples were collected from three sites over two seasons.',
  'Every sample was processed with the same protocol and the same reagents.',
  'Reads were trimmed, aligned and counted against the reference assembly.',
  'Counts were normalised before any comparison was made between groups.',
  'No grid of values appears anywhere on this page.'
]

const prosePdf = () => {
  const lines = ['BT /F1 12 Tf']
  FIXTURE_PROSE_LINES.forEach((text, index) => {
    lines.push(`1 0 0 1 40 ${700 - index * 16} Tm (${text}) Tj`)
  })
  lines.push('ET')
  return pdfFromContent(lines.join('\n'), [], '[0 0 612 792]')
}

// The same six-by-four grid as the unit-level fixture, but every cell placed through a 90-degree text
// matrix. "Left edge / baseline / width" are false on such a page until the parser turns it back to
// upright — so this is the fixture for the panel's rotated-page line, and it must still yield a real
// candidate (six rows by four columns), not a page wrongly reported as having no table.
const FIXTURE_ROTATED_ROWS = [
  ['Gene', 'log2FC', 'p-value', 'adjP'],
  ['geneA', '2.31', '0.004', '0.011'],
  ['geneB', '-1.05', '0.021', '0.038'],
  ['geneC', '0.87', '0.130', '0.170'],
  ['geneD', '3.42', '0.001', '0.003'],
  ['geneE', '-2.10', '0.008', '0.019']
]
// The grid rotates about the origin, so the content it is drawn from necessarily sits at negative x: that
// is what a rotated content stream looks like in user space, and the media box is widened to contain it
// (the same reason the reading is rotated at all).
const FIXTURE_ROTATED_MEDIA_BOX = '[-760 -40 612 792]'

const rotatedTablePdf = () => {
  const lines = ['BT /F1 12 Tf']
  FIXTURE_ROTATED_ROWS.forEach((row, rowIndex) => {
    row.forEach((cell, columnIndex) => {
      const x = 40 + columnIndex * 80
      const y = 700 - rowIndex * 14
      // [0 1 -1 0 -y x]: a 90-degree matrix whose origin is the item's own position, so the parser reads
      // the rotation AND the coordinates the same way it reads a real rotated page.
      lines.push(`0 1 -1 0 ${-y} ${x} Tm (${cell}) Tj`)
    })
  })
  lines.push('ET')
  return pdfFromContent(lines.join('\n'), [], FIXTURE_ROTATED_MEDIA_BOX)
}

const createPdfTableArtifact = async (sessionId) =>
  withMcpClient(sessionId, 'purescience-artifacts', async (client) => {
    const stored = toolResult(
      'write_artifact_file',
      await client.callTool({
        name: 'write_artifact_file',
        arguments: {
          filename: 'table-evidence.pdf',
          mimeType: 'application/pdf',
          encoding: 'base64',
          content: tablePdf()
        }
      })
    )
    if (!stored.artifact?.artifact_id || !stored.artifact.version_id) {
      throw new Error('The table PDF artifact was not stored with a Version.')
    }
    return `Table PDF ready for session ${sessionId}, artifact ${stored.artifact.artifact_id}, version ${stored.artifact.version_id}.`
  })

// Stores one hand-built PDF for the session and returns the receipt line the spec waits for.
const writePdfArtifact = async (sessionId, filename, content, label) =>
  withMcpClient(sessionId, 'purescience-artifacts', async (client) => {
    const stored = toolResult(
      'write_artifact_file',
      await client.callTool({
        name: 'write_artifact_file',
        arguments: { filename, mimeType: 'application/pdf', encoding: 'base64', content }
      })
    )
    if (!stored.artifact?.artifact_id || !stored.artifact.version_id) {
      throw new Error(`The ${label} PDF artifact was not stored with a Version.`)
    }
    return `${label} PDF ready for session ${sessionId}, artifact ${stored.artifact.artifact_id}, version ${stored.artifact.version_id}.`
  })

const createPdfProseArtifact = async (sessionId) =>
  writePdfArtifact(sessionId, 'prose-evidence.pdf', prosePdf(), 'Prose')

const createPdfRotatedTableArtifact = async (sessionId) =>
  writePdfArtifact(sessionId, 'rotated-table-evidence.pdf', rotatedTablePdf(), 'Rotated table')

const createPdfAnnotatedArtifact = async (sessionId) =>
  withMcpClient(sessionId, 'purescience-artifacts', async (client) => {
    const stored = toolResult(
      'write_artifact_file',
      await client.callTool({
        name: 'write_artifact_file',
        arguments: {
          filename: 'annotated-evidence.pdf',
          mimeType: 'application/pdf',
          encoding: 'base64',
          content: annotatedPdf()
        }
      })
    )
    if (!stored.artifact?.artifact_id || !stored.artifact.version_id) {
      throw new Error('The annotated PDF artifact was not stored with a Version.')
    }
    return `Annotated PDF ready for session ${sessionId}, artifact ${stored.artifact.artifact_id}, version ${stored.artifact.version_id}.`
  })

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
    .onRequest(acp.methods.agent.initialize, () => {
      agentLog('initialize')
      return {
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: {
          loadSession: false,
          sessionCapabilities: { close: {}, resume: {} }
        },
        authMethods: []
      }
    })
    .onRequest(acp.methods.agent.authenticate, () => ({}))
    .onRequest(acp.methods.agent.session.new, (context) => {
      const sessionId = `e2e-session-${nextSessionId++}`
      sessionRoutes.set(sessionId, {
        cwd: context.params.cwd,
        mcpServers: context.params.mcpServers ?? []
      })
      agentLog(`session.new -> ${sessionId}`)
      return { sessionId }
    })
    .onRequest(acp.methods.agent.session.resume, (context) => {
      agentLog(`session.resume ${context.params.sessionId}`)
      sessionRoutes.set(context.params.sessionId, {
        cwd: context.params.cwd,
        mcpServers: context.params.mcpServers ?? []
      })
      return {}
    })
    // Loading a stored session is deliberately unsupported (loadSession: false above), but the request is
    // logged so a run that needs it says so instead of failing silently.
    .onRequest(acp.methods.agent.session.load, (context) => {
      agentLog(`session.load ${String(context.params.sessionId)} (unsupported)`)
      throw new Error('session/load is not supported by the fixture agent.')
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
      agentLog(`session.prompt ${context.params.sessionId}: ${prompt.slice(0, 90)}`)
      try {
        if (prompt.includes(SCREENING_PROMPT_MARKER)) {
          reply = screeningReply(prompt)
        } else if (prompt.includes(PROVIDER_BRIDGE_PROMPT)) {
          reply = verifyProviderBridge()
        } else if (prompt.includes(NOTEBOOK_LIFECYCLE_PROMPT)) {
          reply = await verifyNotebookLifecycle(context.params.sessionId)
        } else if (prompt.includes(ARTIFACT_PROVENANCE_PROMPT)) {
          reply = await createProvenanceArtifact(context.params.sessionId)
        } else if (prompt.includes(PDF_PROSE_PROMPT)) {
          reply = await createPdfProseArtifact(context.params.sessionId)
        } else if (prompt.includes(PDF_ROTATED_TABLE_PROMPT)) {
          reply = await createPdfRotatedTableArtifact(context.params.sessionId)
        } else if (prompt.includes(PDF_TABLE_PROMPT)) {
          reply = await createPdfTableArtifact(context.params.sessionId)
        } else if (prompt.includes(PDF_REGION_PROMPT)) {
          reply = await createPdfRegionArtifact(context.params.sessionId)
        } else if (prompt.includes(PDF_ANNOTATED_PROMPT)) {
          reply = await createPdfAnnotatedArtifact(context.params.sessionId)
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

      const replyMessageId = `e2e-${process.pid}-message-${nextMessageId++}`
      // A real agent streams a reply in many chunks; delivering the whole answer in one notification (the
      // default) hides every per-chunk cost from the perf specs — the transcript then commits once per turn
      // instead of once per few characters. `PURESCIENCE_E2E_STREAM_CHUNKS=<n>` splits the reply into n
      // notifications with a small gap, so the smoothness numbers describe streaming rather than delivery.
      const streamChunks = Math.max(1, Number(process.env.PURESCIENCE_E2E_STREAM_CHUNKS ?? 1) || 1)
      const chunkSize = Math.ceil(reply.length / streamChunks)
      // Tool activity is the transcript's *other* per-event channel: an agent emits a tool call, then
      // several status updates for it, and each one used to re-render the whole workspace because the
      // activity arrays travelled inside the session props. The default (0) emits none, exactly as before;
      // `PURESCIENCE_E2E_TOOL_EVENTS=<n>` interleaves n tool-call lifecycles with the text chunks so that
      // channel can be measured on a real machine instead of only in a render-count harness.
      const toolEvents = Math.max(0, Number(process.env.PURESCIENCE_E2E_TOOL_EVENTS ?? 0) || 0)
      const steps = []
      const toolEvery = toolEvents > 0 ? Math.max(1, Math.floor(streamChunks / toolEvents)) : 0
      let emittedTools = 0
      for (let offset = 0, index = 0; offset < reply.length; offset += chunkSize, index += 1) {
        if (toolEvery > 0 && index > 0 && index % toolEvery === 0 && emittedTools < toolEvents) {
          emittedTools += 1
          steps.push({ kind: 'tool', index: emittedTools })
        }
        steps.push({ kind: 'text', text: reply.slice(offset, offset + chunkSize) })
      }
      // A short reply offers fewer interleaving points than requested activities, so the rest follow the
      // text: the switch promises *n* lifecycles, not "n if the answer happens to be long enough".
      while (emittedTools < toolEvents) {
        emittedTools += 1
        steps.push({ kind: 'tool', index: emittedTools })
      }
      for (let stepIndex = 0; stepIndex < steps.length; stepIndex += 1) {
        const step = steps[stepIndex]
        const isLastStep = stepIndex === steps.length - 1
        if (step.kind === 'tool') {
          const toolCallId = `e2e-${process.pid}-tool-${step.index}`
          const notify = async (update) =>
            context.client.notify(acp.methods.client.session.update, {
              sessionId: context.params.sessionId,
              update
            })
          // One lifecycle, the shape a real agent sends: announced, running, done.
          await notify({
            sessionUpdate: 'tool_call',
            toolCallId,
            title: `Search repositories ${step.index}`,
            kind: 'fetch',
            status: 'in_progress'
          })
          await notify({
            sessionUpdate: 'tool_call_update',
            toolCallId,
            title: `Search repositories ${step.index}`,
            kind: 'fetch',
            status: 'completed'
          })
          agentLog(`tool -> ${context.params.sessionId} ${toolCallId}: completed`)
          continue
        }
        await context.client.notify(acp.methods.client.session.update, {
          sessionId: context.params.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            messageId: replyMessageId,
            content: { type: 'text', text: step.text }
          }
        })
        if (!isLastStep) await new Promise((resolve) => setTimeout(resolve, 5))
      }
      // The request log says what the app asked for; this says what it was told back. Without it a reply the
      // app failed to render looks identical to an agent that never answered.
      agentLog(
        `reply -> ${context.params.sessionId} ${replyMessageId}: ${reply.slice(0, 70).replaceAll('\n', ' ')}`
      )

      return { stopReason: 'end_turn' }
    })
    .onNotification(acp.methods.agent.session.cancel, () => undefined)
    .onRequest(acp.methods.agent.session.close, () => ({}))

  const connection = app.connect(
    acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin))
  )
  await connection.closed
}
