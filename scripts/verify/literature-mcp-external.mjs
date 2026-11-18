// A verification script, not product code: the arrow helpers below are one-liners whose return type adds
// nothing a reader cannot see, and this file is deliberately plain .mjs so it runs without a build step.
/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Verifies the literature MCP server the way an external client uses it: spawn the child over stdio, list its
// tools, and call all three against the live indexes. Nothing in-process — if this prints records, a Claude
// Desktop / Cursor / script client would get the same.
//
// Usage (from the repo root, after `npx electron-vite build`):
//   node scripts/verify/literature-mcp-external.mjs
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

const ENTRY = resolve('out/main/index.js')
if (!existsSync(ENTRY)) {
  console.error(`missing ${ENTRY} — run: npx electron-vite build`)
  process.exit(1)
}

const transport = new StdioClientTransport({
  command: resolve('node_modules/.bin/electron'),
  args: [ENTRY, '--purescience-literature-mcp'],
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  stderr: 'pipe'
})
transport.stderr?.on('data', (chunk) => process.stderr.write(`[server] ${chunk}`))

const client = new Client({ name: 'external-verify', version: '0.0.0' })
await client.connect(transport)

const text = (result) => (result.content ?? []).map((part) => part.text ?? '').join('')

const report = (label, payload) => {
  console.log(`\n=== ${label} ===`)
  console.log(typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2))
}

try {
  const { tools } = await client.listTools()
  report(
    'tools/list',
    tools.map((tool) => ({ name: tool.name, title: tool.title }))
  )

  const search = await client.callTool({
    name: 'literature_search',
    arguments: { query: 'semaglutide obesity', limit: 3 }
  })
  const payload = JSON.parse(text(search))
  report('literature_search: semaglutide obesity', {
    errors: payload.errors,
    count: payload.records.length,
    records: payload.records.map((record) => ({
      source: record.source,
      title: record.title.slice(0, 70),
      year: record.year,
      venue: record.venue,
      doi: record.doi,
      pmid: record.pmid,
      read: record.read,
      abstractChars: (record.abstract ?? '').length
    }))
  })

  const cite = await client.callTool({
    name: 'literature_cite',
    arguments: { identifier: '10.1056/NEJMoa2034577' }
  })
  report('literature_cite: 10.1056/NEJMoa2034577', JSON.parse(text(cite)))

  const one = await client.callTool({
    name: 'literature_get',
    arguments: { identifier: '2103.14030' }
  })
  const record = JSON.parse(text(one))
  report('literature_get: arXiv 2103.14030', {
    title: record.title,
    authors: record.authors?.slice(0, 3),
    year: record.year,
    arxivId: record.arxivId,
    read: record.read
  })
} finally {
  await client.close()
}
