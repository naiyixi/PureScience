// Per-server readiness readings for the MCP children a session hands to the agent.
//
// Why this exists: the agent enforces ONE readiness budget over every server it was given
// (`waitForMcpServers`, 10 s in our patch), so a single slow server costs the whole session — on a
// real machine 11 of 14 timed out at once and the first `session/new` failed, then a retry (with warm
// caches) succeeded and hid the problem. `session capabilities built` already says how long WE took to
// assemble the configs (`buildMs`); it says nothing about how long each child takes to answer
// `initialize`. Without that second number "we hand over slowly" and "they boot slowly" stay
// indistinguishable, and the only honest fix (make the expensive half cheaper) cannot be chosen.
//
// The probe is OPT-IN (`PURESCIENCE_MCP_READINESS_PROBE=1`): it really spawns every server once, so it
// must never run on a normal session. It measures two passes on purpose:
//   serial — one child at a time ⇒ intrinsic cost (module graph, node boot, first RPC)
//   burst  — all of them at once ⇒ what contention adds (that is the state the agent sees)
// Reporting only one of them invites the wrong fix: a big burst/serial gap is CPU/disk contention, a
// high serial cost is the child's own import graph.

import { spawn } from 'node:child_process'
import type { McpServer } from '@agentclientprotocol/sdk'

export const MCP_READINESS_PROBE_ENV = 'PURESCIENCE_MCP_READINESS_PROBE'

// Larger than the agent's own 10 s budget on purpose: the reading has to say HOW long the child needed,
// and a probe that gives up at the same second only reproduces "timed out".
export const MCP_READINESS_PROBE_TIMEOUT_MS = 30_000

const INITIALIZE_REQUEST_ID = 1
const TOOLS_LIST_REQUEST_ID = 2
const STDERR_TAIL_CHARS = 400

type ProbeChildHandlers = {
  stdout?: NodeJS.EventEmitter | null
  stderr?: NodeJS.EventEmitter | null
  stdin?: { write: (chunk: string) => void } | null
  on: (event: 'spawn' | 'error' | 'exit', listener: (...args: unknown[]) => void) => unknown
  kill?: (signal?: NodeJS.Signals) => unknown
}

export type McpServerProbeSpawn = (
  command: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; stdio: readonly string[] }
) => ProbeChildHandlers

export type McpReadinessStatus = 'ready' | 'timeout' | 'exited' | 'spawn-error'

export interface McpReadinessSample {
  name: string
  status: McpReadinessStatus
  /** Milliseconds from `spawn()` to the child's own `spawn` event — node itself booting. */
  spawnMs: number
  /** Milliseconds from `spawn()` to the `initialize` answer; -1 when it never answered. */
  initializeMs: number
  /**
   * Milliseconds from `spawn()` to the `tools/list` answer; -1 when it never came.
   * The agent calls a server `connected` only after its tool list is in, so this — not
   * `initializeMs` — is the number the readiness budget is actually spent on.
   */
  toolsMs: number
  /** Tools the server listed, or -1 when `tools/list` never answered. */
  toolCount: number
  /** Protocol version the child chose, or the failure text (stderr tail / exit code / spawn error). */
  detail?: string
}

export interface McpReadinessProbeOptions {
  timeoutMs?: number
  spawnImpl?: McpServerProbeSpawn
  now?: () => number
}

export interface McpReadinessProbeResult {
  /** One child at a time: intrinsic per-server cost. */
  serial: McpReadinessSample[]
  /** All children at once: the picture the agent's single budget actually sees. */
  burst: McpReadinessSample[]
}

export const shouldProbeMcpReadiness = (env: NodeJS.ProcessEnv = process.env): boolean => {
  const raw = env[MCP_READINESS_PROBE_ENV]
  return raw === '1' || raw === 'true'
}

const isStdioServer = (server: McpServer): server is Extract<McpServer, { command: string }> =>
  typeof (server as { command?: unknown }).command === 'string'

const envPairsToProcessEnv = (
  server: Extract<McpServer, { command: string }>
): NodeJS.ProcessEnv => {
  const pairs = (server as { env?: Array<{ name: string; value: string }> }).env ?? []
  const merged: NodeJS.ProcessEnv = { ...process.env }
  for (const pair of pairs) merged[pair.name] = pair.value
  return merged
}

const toolsListRequest = (): string =>
  `${JSON.stringify({ jsonrpc: '2.0', id: TOOLS_LIST_REQUEST_ID, method: 'tools/list', params: {} })}\n`

const initializeRequest = (): string =>
  `${JSON.stringify({
    jsonrpc: '2.0',
    id: INITIALIZE_REQUEST_ID,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'purescience-readiness-probe', version: '1' }
    }
  })}\n`

/**
 * Spawn one server the way the agent would and time the `initialize` handshake.
 * Always settles: a child that never answers resolves as `timeout` after `timeoutMs`.
 */
export const probeMcpServerReadiness = (
  server: Extract<McpServer, { command: string }>,
  options: McpReadinessProbeOptions = {}
): Promise<McpReadinessSample> => {
  const timeoutMs = options.timeoutMs ?? MCP_READINESS_PROBE_TIMEOUT_MS
  const spawnImpl: McpServerProbeSpawn =
    options.spawnImpl ?? (spawn as unknown as McpServerProbeSpawn)
  const now = options.now ?? Date.now
  const name = server.name
  const startedAt = now()

  return new Promise<McpReadinessSample>((resolve) => {
    let settled = false
    let child: ProbeChildHandlers | undefined
    let spawnMs = -1
    let stderrTail = ''
    let stdoutBuffer = ''
    let exitDetail: string | undefined

    let toolsMs = -1
    let toolCount = -1
    let initializeMs = -1
    let protocolVersion: string | undefined

    const finish = (status: McpReadinessStatus, detail?: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        child?.kill?.('SIGKILL')
      } catch {
        /* the child may already be gone; teardown must not throw into session creation */
      }
      resolve({
        name,
        status,
        spawnMs,
        initializeMs,
        toolsMs,
        toolCount,
        ...(detail ? { detail: detail.slice(0, STDERR_TAIL_CHARS) } : {})
      })
    }

    // Armed before the spawn so every early return below (spawn throw included) has a handle to clear.
    const timer = setTimeout(() => {
      const detail = exitDetail ?? (stderrTail || 'no answer within budget')
      finish('timeout', detail)
    }, timeoutMs)

    try {
      child = spawnImpl(server.command, server.args ?? [], {
        env: envPairsToProcessEnv(server),
        stdio: ['pipe', 'pipe', 'pipe']
      })
    } catch (error) {
      finish('spawn-error', error instanceof Error ? error.message : String(error))
      return
    }

    child.on('spawn', () => {
      spawnMs = now() - startedAt
    })
    child.on('error', (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      finish('spawn-error', message)
    })
    child.on('exit', (...args: unknown[]) => {
      const code = typeof args[0] === 'number' ? args[0] : 'unknown'
      exitDetail = `exited with code ${code}${stderrTail ? `: ${stderrTail}` : ''}`
      finish('exited', exitDetail)
    })
    child.stderr?.on('data', (...args: unknown[]) => {
      const chunk = args[0]
      const text =
        typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString() : ''
      stderrTail = `${stderrTail}${text}`.slice(-STDERR_TAIL_CHARS)
    })
    child.stdout?.on('data', (...args: unknown[]) => {
      const chunk = args[0]
      const text =
        typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString() : ''
      stdoutBuffer += text
      let newlineAt = stdoutBuffer.indexOf('\n')
      while (newlineAt >= 0) {
        const line = stdoutBuffer.slice(0, newlineAt).trim()
        stdoutBuffer = stdoutBuffer.slice(newlineAt + 1)
        newlineAt = stdoutBuffer.indexOf('\n')
        if (!line) continue
        try {
          const message = JSON.parse(line) as {
            id?: unknown
            result?: { protocolVersion?: unknown; tools?: unknown }
            error?: { message?: unknown }
          }
          if (message.id === INITIALIZE_REQUEST_ID) {
            if (message.error) {
              finish('exited', `initialize failed: ${String(message.error.message ?? '')}`)
              return
            }
            initializeMs = now() - startedAt
            const version = message.result?.protocolVersion
            protocolVersion = typeof version === 'string' ? version : undefined
            // A client counts a server ready only once its tool list is in — ask for it the same way,
            // otherwise this reading under-reports exactly the half the agent waits on.
            try {
              child.stdin?.write(
                `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`
              )
              child.stdin?.write(toolsListRequest())
            } catch (error) {
              finish('ready', error instanceof Error ? error.message : String(error))
            }
            continue
          }
          if (message.id === TOOLS_LIST_REQUEST_ID) {
            toolsMs = now() - startedAt
            const tools = message.result?.tools
            toolCount = Array.isArray(tools) ? tools.length : -1
            finish(
              'ready',
              message.error
                ? `tools/list failed: ${String(message.error.message ?? '')}`
                : protocolVersion
            )
            return
          }
        } catch {
          /* not a JSON-RPC frame (some servers log to stdout) — keep reading */
        }
      }
    })

    try {
      child.stdin?.write(initializeRequest())
    } catch (error) {
      finish('spawn-error', error instanceof Error ? error.message : String(error))
    }
  })
}

const probeAll = async (
  servers: readonly Extract<McpServer, { command: string }>[],
  options: McpReadinessProbeOptions,
  concurrent: boolean
): Promise<McpReadinessSample[]> => {
  if (!concurrent) {
    const samples: McpReadinessSample[] = []
    for (const server of servers) samples.push(await probeMcpServerReadiness(server, options))
    return samples
  }
  return Promise.all(servers.map((server) => probeMcpServerReadiness(server, options)))
}

/**
 * Serial pass, then a concurrent pass. Servers without a `command` (http transports) are skipped —
 * they have no child to boot, so timing them would answer a different question.
 */
export const runMcpReadinessProbe = async (
  servers: readonly McpServer[],
  options: McpReadinessProbeOptions = {}
): Promise<McpReadinessProbeResult> => {
  const stdioServers = servers.filter(isStdioServer)
  if (stdioServers.length === 0) return { serial: [], burst: [] }
  const serial = await probeAll(stdioServers, options, false)
  const burst = await probeAll(stdioServers, options, true)
  return { serial, burst }
}

/** `name=ms` for the slowest samples, ready or not — what a reader needs first. */
export const summariseMcpReadiness = (
  samples: readonly McpReadinessSample[],
  limit = 5
): { ready: number; failed: string[]; slowest: string } => {
  const ready = samples.filter((sample) => sample.status === 'ready').length
  const failed = samples
    .filter((sample) => sample.status !== 'ready')
    .map((sample) => `${sample.name}:${sample.status}`)
    .sort()
  // Ranked by `toolsMs`: that is when the agent's readiness budget stops being spent. A server whose
  // `tools/list` never answered keeps its -1 in the ranking so it can never look fast.
  const slowest = [...samples]
    .sort((left, right) => {
      const leftMs = left.toolsMs >= 0 ? left.toolsMs : Number.MAX_SAFE_INTEGER
      const rightMs = right.toolsMs >= 0 ? right.toolsMs : Number.MAX_SAFE_INTEGER
      return rightMs - leftMs
    })
    .slice(0, limit)
    .map((sample) => `${sample.name}=${sample.toolsMs}`)
    .join(',')
  return { ready, failed, slowest }
}
