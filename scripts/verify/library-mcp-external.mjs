// A verification script, not product code: the one-line arrow helpers below buy nothing wrapped in return-type
// annotations, and this stays plain .mjs so it runs without a build step.
/* eslint-disable @typescript-eslint/explicit-function-return-type */
// External-client verification for the library tools: an MCP client (this script, through the bridge the app
// publishes) searches, reads, and — for the write — waits while a human answer is supplied through the app's
// own permission surface, exactly as a real deployment would.
//
//   node scripts/verify/library-mcp-external.mjs <projectId|projectName>
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
const CONFIG_ROOT = process.env.PURESCIENCE_CONFIG_ROOT ?? '/tmp/ps-verify23-config'
const project = process.argv[2]
const sessionId = process.argv[3]
if (!project || !sessionId) {
  console.error('usage: node scripts/verify/library-mcp-external.mjs <project> <sessionId>')
  process.exit(2)
}

const cli = (args) =>
  run('node', ['packages/purescience/cli.mjs', ...args, '--config-root', CONFIG_ROOT, '--json'], {
    maxBuffer: 8 * 1024 * 1024
  }).then((result) => result.stdout)

const transport = new StdioClientTransport({
  command: 'node',
  args: ['packages/purescience/cli.mjs', 'mcp', '--config-root', CONFIG_ROOT],
  stderr: 'pipe'
})
const client = new Client({ name: 'library-verify', version: '0.0.0' })
await client.connect(transport)

const call = async (name, args) => {
  const result = await client.callTool({ name, arguments: args })
  const text = (result.content ?? []).map((part) => part.text ?? '').join('')
  return { payload: JSON.parse(text), isError: result.isError === true }
}

// Answers the pending card the way an operator would when no window is open: read the queue, approve by id.
const approvePending = async () => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const listed = JSON.parse(await cli(['permissions']))
    const pending = (Array.isArray(listed) ? listed : (listed.requests ?? []))[0]
    if (pending !== undefined) {
      const optionId = pending.options?.[0]?.id ?? pending.options?.[0]?.optionId
      await cli(['approve', String(pending.id ?? pending.requestId), '--option', String(optionId)])
      return pending
    }
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  return undefined
}

const report = (label, value) =>
  console.log(`\n=== ${label} ===\n${JSON.stringify(value, null, 2)}`)

try {
  const empty = await call('search_library', { project })
  report('search_library (empty library)', {
    total: empty.payload.total,
    truncated: empty.payload.truncated,
    references: empty.payload.references?.length
  })

  // The write: start it, then answer the card from another process while it waits.
  const approving = approvePending()
  const added = await call('add_reference', {
    project,
    sessionId,
    title: '深度学习在医学影像中的应用与挑战',
    authors: ['张三', '李四'],
    year: 2024,
    venue: '中华放射学杂志',
    doi: '10.3760/cma.j.cn112149-20240101-00001',
    notes: '外部 MCP 客户端写入'
  })
  const approved = await approving
  report('add_reference (after approval)', {
    isError: added.isError,
    approvedCard: approved?.title ?? approved?.request?.title ?? null,
    added: added.payload.added ?? added.payload.error,
    citationKey: added.payload.citationKey ?? null
  })

  const found = await call('search_library', { project, query: '医学影像' })
  report('search_library (Chinese query)', {
    total: found.payload.total,
    references: (found.payload.references ?? []).map((row) => ({
      id: row.id,
      title: row.title,
      authors: row.authors,
      doi: row.doi,
      hasPdf: row.hasPdf
    }))
  })

  const referenceId = found.payload.references?.[0]?.id
  const one = await call('get_reference', { project, doi: '10.3760/cma.j.cn112149-20240101-00001' })
  report('get_reference (by DOI)', {
    id: one.payload.reference?.id ?? one.payload.error,
    title: one.payload.reference?.title,
    notes: one.payload.reference?.notes
  })

  const notesApproval = approvePending()
  const noted = await call('set_reference_notes', {
    project,
    sessionId,
    referenceId,
    notes: '方法学参考（已由外部客户端更新）'
  })
  await notesApproval
  report('set_reference_notes', {
    isError: noted.isError,
    notes: noted.payload.notes ?? noted.payload.error
  })

  const removeApproval = approvePending()
  const removed = await call('remove_reference', { project, sessionId, referenceId })
  await removeApproval
  report('remove_reference', {
    isError: removed.isError,
    removed: removed.payload.removed ?? removed.payload.error
  })

  const after = await call('search_library', { project })
  report('search_library (after removal)', { total: after.payload.total })
} finally {
  await client.close()
}
