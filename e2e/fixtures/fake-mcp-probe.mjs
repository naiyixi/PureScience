#!/usr/bin/env node
// A minimal MCP server over stdio (newline-delimited JSON-RPC), used by the certification lane to give the
// window a REAL user-added server to talk to: the Settings detail must show the tools this process
// advertises, so the list cannot be faked in the renderer.
//
// Implements only what the detail page needs: initialize, tools/list, and a tools/call that answers (so a
// permission change can be exercised end to end if a test wants it).
import { createInterface } from 'node:readline'

const TOOLS = [
  {
    name: 'probe_alpha',
    description: 'Alpha probe tool',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: [] }
  },
  {
    name: 'probe_beta',
    description: 'Beta probe tool',
    inputSchema: { type: 'object', properties: {}, required: [] }
  }
]

/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain .mjs: TS annotations would make
   the file unparseable for prettier and for the node process the app spawns. */
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)

const lines = createInterface({ input: process.stdin })
lines.on('line', (line) => {
  const text = line.trim()
  if (!text) return
  let request
  try {
    request = JSON.parse(text)
  } catch {
    return
  }

  switch (request.method) {
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id: request.id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'probe-mcp', version: '1.0.0' }
        }
      })
      break
    case 'notifications/initialized':
      break
    case 'tools/list':
      send({ jsonrpc: '2.0', id: request.id, result: { tools: TOOLS } })
      break
    case 'tools/call':
      send({
        jsonrpc: '2.0',
        id: request.id,
        result: {
          content: [
            { type: 'text', text: `probe-mcp answered ${request.params?.name ?? 'unknown'}` }
          ]
        }
      })
      break
    default:
      send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } })
  }
})

lines.on('close', () => process.exit(0))
