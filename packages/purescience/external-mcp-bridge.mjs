/* eslint-disable @typescript-eslint/explicit-function-return-type */

// `purescience mcp`: bridges an outside MCP client's stdio to the running app.
//
// The client (a desktop assistant, a script) launches this process and speaks MCP over stdin/stdout; the app
// publishes where it listens and with which token in `external-mcp.json` in the config root. This module is
// the whole of the CLI side, deliberately dependency-free: the CLI package ships with no runtime deps, and a
// hand-written byte bridge is smaller than vendoring an SDK into it.
//
// Two things it deliberately does NOT do:
// - It never accepts a caller-supplied endpoint or token. It reads the app's own published state (or the
//   config root named by `--config-root` / `PURESCIENCE_CONFIG_ROOT`, which is how a probe inside an
//   isolated root talks to an isolated instance), so an outside program cannot point the app's authority
//   at another host.
// - It never prints the token. Refusals name what is missing, not the secret.
//
// Exit codes are part of the contract and are distinct on purpose:
//   0  the client closed the stream (normal end)
//   3  the app is not reachable (not running, or the published endpoint refuses connections)
//   4  the app is running but its published state is unusable (missing/corrupt token, 401)

import { createInterface } from 'node:readline'
import { request as httpRequest } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { candidateConfigRoots } from './config-root.mjs'

export const EXTERNAL_MCP_STATE_FILE = 'external-mcp.json'

export const EXIT_OK = 0
export const EXIT_APP_NOT_RUNNING = 3
export const EXIT_STATE_UNUSABLE = 4

const isProcessAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

// Reads the app's published endpoint for this machine. Returns the first state file whose owner process is
// alive; a state file left behind by a crash is reported as "not running" rather than handed back.
export const findExternalMcpState = async ({ override, env = process.env } = {}) => {
  for (const configRoot of candidateConfigRoots({ override, env })) {
    let raw
    try {
      raw = await readFile(join(configRoot, EXTERNAL_MCP_STATE_FILE), 'utf8')
    } catch {
      continue
    }
    let state
    try {
      state = JSON.parse(raw)
    } catch {
      continue
    }
    if (
      !Number.isInteger(state.pid) ||
      typeof state.endpoint !== 'string' ||
      typeof state.token !== 'string'
    ) {
      continue
    }
    if (!isProcessAlive(state.pid)) continue
    return { ...state, configRoot }
  }
  return undefined
}

const postJson = ({ endpoint, token, sessionId, protocolVersion, body, timeoutMs }) =>
  new Promise((resolve, reject) => {
    const url = new URL(endpoint)
    const payload = Buffer.from(JSON.stringify(body), 'utf8')
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'content-length': String(payload.length),
      authorization: `Bearer ${token}`
    }
    if (sessionId) headers['mcp-session-id'] = sessionId
    if (protocolVersion) headers['mcp-protocol-version'] = protocolVersion

    const req = httpRequest(
      {
        host: url.hostname,
        port: url.port ? Number(url.port) : 80,
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        headers
      },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            text: Buffer.concat(chunks).toString('utf8')
          })
        )
      }
    )
    req.setTimeout(timeoutMs, () => req.destroy(new Error('external MCP request timed out')))
    req.on('error', reject)
    req.write(payload)
    req.end()
  })

// Streamable HTTP may answer a POST as SSE. The app asks for JSON responses, but a stream must still be read
// rather than treated as "no answer": refuse to guess, take the `data:` frames and return the one whose id
// matches.
const jsonRpcBodyFrom = (response, requestId) => {
  const contentType = String(response.headers['content-type'] ?? '')
  if (!contentType.includes('text/event-stream')) {
    const text = response.text.trim()
    return text === '' ? undefined : text
  }
  const payloads = []
  for (const line of response.text.split('\n')) {
    if (!line.startsWith('data:')) continue
    const data = line.slice(5).trim()
    if (data === '' || data === '[DONE]') continue
    payloads.push(data)
  }
  const matching = payloads.find((payload) => {
    try {
      return JSON.parse(payload)?.id === requestId
    } catch {
      return false
    }
  })
  return matching ?? payloads[payloads.length - 1]
}

/**
 * Runs the bridge until the client closes stdin. `write` receives one JSON-RPC reply per line.
 * Returns an exit code.
 */
export const runExternalMcpBridge = async ({ state, input, write, timeoutMs = 120_000 }) => {
  const sessions = { sessionId: undefined, protocolVersion: undefined }
  const send = (message) => write(`${JSON.stringify(message)}\n`)

  for await (const line of input) {
    const trimmed = line.trim()
    if (trimmed === '') continue

    let message
    try {
      message = JSON.parse(trimmed)
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
      continue
    }

    let response
    try {
      response = await postJson({
        endpoint: state.endpoint,
        token: state.token,
        sessionId: sessions.sessionId,
        protocolVersion: sessions.protocolVersion,
        body: message,
        timeoutMs
      })
    } catch (error) {
      // The transport died mid-stream: the client must learn this rather than wait forever.
      send({
        jsonrpc: '2.0',
        id: message.id ?? null,
        error: { code: -32001, message: `PureScience is not reachable: ${error.message}` }
      })
      return EXIT_APP_NOT_RUNNING
    }

    if (response.status === 401 || response.status === 403) return EXIT_STATE_UNUSABLE
    if (response.status === 421) return EXIT_STATE_UNUSABLE
    if (response.status >= 500) {
      send({
        jsonrpc: '2.0',
        id: message.id ?? null,
        error: {
          code: -32603,
          message: `PureScience refused the request (HTTP ${response.status})`
        }
      })
      continue
    }

    const sessionId = response.headers['mcp-session-id']
    if (typeof sessionId === 'string' && sessionId !== '') sessions.sessionId = sessionId
    const protocolVersion = response.headers['mcp-protocol-version']
    if (typeof protocolVersion === 'string' && protocolVersion !== '') {
      sessions.protocolVersion = protocolVersion
    }

    const body = jsonRpcBodyFrom(response, message.id)
    if (body !== undefined) write(`${body}\n`)
  }

  return EXIT_OK
}

/** One request/response round trip, used by `purescience mcp --list-tools`. */
export const callExternalMcp = async ({ state, message, sessionId, timeoutMs = 30_000 }) => {
  const response = await postJson({
    endpoint: state.endpoint,
    token: state.token,
    sessionId,
    protocolVersion: undefined,
    body: message,
    timeoutMs
  })
  return { response, body: jsonRpcBodyFrom(response, message.id) }
}

/** Reads `tools/list` from the running app: name, title and risk as the surface declares them. */
export const listExternalMcpTools = async (state) => {
  const initialize = await callExternalMcp({
    state,
    message: {
      jsonrpc: '2.0',
      id: 'init-1',
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'purescience-cli', version: '1.0.0' }
      }
    }
  })
  if (initialize.response.status !== 200) {
    return {
      ok: false,
      exitCode: EXIT_STATE_UNUSABLE,
      detail: `HTTP ${initialize.response.status}`
    }
  }
  const sessionId = initialize.response.headers['mcp-session-id']
  if (typeof sessionId !== 'string') {
    return { ok: false, exitCode: EXIT_STATE_UNUSABLE, detail: 'no mcp-session-id in the reply' }
  }
  await callExternalMcp({
    state,
    // The notification belongs to the session the initialize reply created: sending it without a session
    // id would open a second MCP session inside the app and leave it there.
    sessionId,
    message: { jsonrpc: '2.0', method: 'notifications/initialized' }
  }).catch(() => undefined)
  const listed = await callExternalMcp({
    state,
    sessionId,
    message: { jsonrpc: '2.0', id: 'list-1', method: 'tools/list', params: {} }
  })
  if (listed.response.status !== 200) {
    return { ok: false, exitCode: EXIT_STATE_UNUSABLE, detail: `HTTP ${listed.response.status}` }
  }
  if (!listed.body)
    return { ok: false, exitCode: EXIT_STATE_UNUSABLE, detail: 'empty tools/list reply' }
  const tools = JSON.parse(listed.body)?.result?.tools ?? []
  return { ok: true, tools }
}

/** Feeds `readline`'s async iterator from a stream, so `runExternalMcpBridge` stays transport-agnostic. */
export const linesOf = (stream) =>
  createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY })
