// Managed-endpoint lifecycle: the state machine behind endpoint_start / endpoint_stop. When a
// start is requested the manager runs the approved start script with HOST_PORT, SERVICE_DIR
// and the credential VALUE injected via env (agent code never sees the secret), then polls the
// endpoint's readiness route until the model answers or ENDPOINT_READY_TIMEOUT_MS elapses.
// Every transition is persisted through the repository; setStateIfStill guards against a slow
// start clobbering a concurrent stop (and vice versa). This mirrors the reference product's
// daemon-owned lifecycle for locally hosted model servers.

import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import type {
  EndpointFreePortResult,
  EndpointStartResult,
  EndpointStopResult,
  ManagedEndpoint
} from '../../shared/endpoint'
import {
  ENDPOINT_PORT_RANGE_END,
  ENDPOINT_PORT_RANGE_START,
  ENDPOINT_READY_POLL_MS,
  ENDPOINT_READY_TIMEOUT_MS,
  ENDPOINT_STATE_FAILED,
  ENDPOINT_STATE_LIVE,
  ENDPOINT_STATE_STARTING,
  ENDPOINT_STATE_STOPPED
} from '../../shared/endpoint'
import type { EndpointRepository } from './endpoint-repository'

const ENDPOINTS_DIR = '.endpoints'

export type EndpointManagerDeps = {
  repository: EndpointRepository
  // Resolves the credential VALUE by name (never surfaced to agent code — injected into the
  // start script env only). Return undefined for "no credential".
  resolveCredential: (name: string) => Promise<string | undefined>
  // Runs an approved start script. Injectable for tests; default spawns bash.
  runScript?: (script: string, env: Record<string, string>) => Promise<{ ok: boolean; error?: string }>
  // Probes a URL for readiness. Injectable for tests; default fetch.
  probe?: (url: string) => Promise<boolean>
  // Socket-liveness probe for free_port. Injectable for tests; default fetch-based.
  isPortBound?: (port: number) => Promise<boolean>
  now?: () => number
  timeoutMs?: number
  pollMs?: number
}

export class EndpointManager {
  constructor(private readonly deps: EndpointManagerDeps) {}

  // Allocates a random port in the managed range, skipping ports owned by other endpoints and
  // ports currently bound on the machine.
  async freePort(): Promise<EndpointFreePortResult> {
    const endpoints = await this.deps.repository.list()
    const owned = new Set(endpoints.map((endpoint) => endpoint.port))
    const bound = async (port: number) => {
      if (owned.has(port)) return true
      try {
        return await this.deps.isPortBound?.(port)
      } catch {
        return true // be conservative: skip if we cannot tell
      }
    }
    const range = ENDPOINT_PORT_RANGE_END - ENDPOINT_PORT_RANGE_START + 1
    // Random draws with a hard cap so a full range never loops forever.
    for (let attempt = 0; attempt < range; attempt++) {
      const port =
        ENDPOINT_PORT_RANGE_START + Math.floor(Math.random() * (ENDPOINT_PORT_RANGE_END - ENDPOINT_PORT_RANGE_START + 1))
      if (!(await bound(port))) return { port }
    }
    throw new Error('No free port in the managed range 20000-29999.')
  }

  // Runs the approved start script and waits for readiness. State transitions:
  // stopped → starting → live | failed. Idempotent: an already-live endpoint is a no-op.
  async start(name: string): Promise<EndpointStartResult> {
    const endpoint = await this.deps.repository.get(name)
    if (!endpoint) {
      throw new Error(`No managed endpoint named "${name}".`)
    }
    if (endpoint.state === ENDPOINT_STATE_LIVE) {
      return { endpoint }
    }
    const approved = await this.deps.repository.isHashApproved(endpoint.approvedScriptHash)
    if (!approved) {
      throw new Error(
        `Endpoint "${name}" is registered but its start script has not been approved yet. ` +
          'Open Settings → Local models and approve it (scripts are shown verbatim there) before starting.'
      )
    }
    if (endpoint.state === ENDPOINT_STATE_FAILED) {
      await this.deps.repository.clearFailure(name)
    }

    const timeoutMs = this.deps.timeoutMs ?? ENDPOINT_READY_TIMEOUT_MS
    const pollMs = this.deps.pollMs ?? ENDPOINT_READY_POLL_MS
    const now = this.deps.now?.() ?? Date.now()

    const pending = await this.deps.repository.setState(name, ENDPOINT_STATE_STARTING, {
      error: null,
      transcript: `[${iso(now)}] start requested`
    })
    if (!pending) throw new Error(`No managed endpoint named "${name}".`)

    const env = await this.buildScriptEnv(endpoint)
    const result = await (this.deps.runScript ?? defaultRunScript)(endpoint.startScript, env)

    if (!result.ok) {
      await this.deps.repository.setState(name, ENDPOINT_STATE_FAILED, {
        error: result.error ?? 'start script failed',
        transcript: `[${iso(Date.now())}] start script failed: ${result.error ?? 'unknown'}`
      })
      return { endpoint: (await this.deps.repository.get(name))! }
    }

    // Poll the readiness route.
    const probe = this.deps.probe ?? defaultProbe
    const readyUrl = `${endpoint.url}${endpoint.livePath}`
    const deadline = Date.now() + timeoutMs
    let lastProbeError = 'no response'
    while (Date.now() < deadline) {
      const ok = await probe(readyUrl)
      if (ok) {
        const live = await this.deps.repository.setStateIfStill(
          name,
          ENDPOINT_STATE_STARTING,
          ENDPOINT_STATE_LIVE,
          { transcript: `[${iso(Date.now())}] ready at ${readyUrl}` }
        )
        return { endpoint: live ?? (await this.deps.repository.get(name))! }
      }
      lastProbeError = `not ready at ${readyUrl}`
      await sleep(pollMs)
    }

    // Timed out: run the stop script to unwind whatever the start script brought up, then fail.
    await (this.deps.runScript ?? defaultRunScript)(endpoint.stopScript, env)
    await this.deps.repository.setState(name, ENDPOINT_STATE_FAILED, {
      error: `readiness probe timed out after ${Math.round(timeoutMs / 1000)}s (${lastProbeError})`,
      transcript: `[${iso(Date.now())}] readiness timeout, stop script run`
    })
    return { endpoint: (await this.deps.repository.get(name))! }
  }

  // Runs the stop script and moves the endpoint to stopped. Idempotent.
  async stop(name: string): Promise<EndpointStopResult> {
    const endpoint = await this.deps.repository.get(name)
    if (!endpoint) {
      throw new Error(`No managed endpoint named "${name}".`)
    }
    if (endpoint.state === ENDPOINT_STATE_STOPPED) {
      return { endpoint }
    }
    if (endpoint.state === ENDPOINT_STATE_FAILED) {
      await this.deps.repository.clearFailure(name)
      return { endpoint: (await this.deps.repository.get(name))! }
    }
    if (endpoint.state === ENDPOINT_STATE_STARTING) {
      // A start is in flight; the state machine will resolve it. Ask the script env anyway so a
      // half-started service gets torn down if the script is idempotent.
    }

    const env = await this.buildScriptEnv(endpoint)
    const result = await (this.deps.runScript ?? defaultRunScript)(endpoint.stopScript, env)
    await this.deps.repository.setState(name, ENDPOINT_STATE_STOPPED, {
      error: null,
      transcript: result.ok
        ? `[${iso(Date.now())}] stopped`
        : `[${iso(Date.now())}] stop script failed (${result.error ?? 'unknown'})`
    })
    return { endpoint: (await this.deps.repository.get(name))! }
  }

  // Removes an endpoint, stopping it first if live. Returns false when no such endpoint.
  async unregister(name: string): Promise<boolean> {
    const endpoint = await this.deps.repository.get(name)
    if (!endpoint) return false
    if (endpoint.state === ENDPOINT_STATE_LIVE || endpoint.state === ENDPOINT_STATE_STARTING) {
      await this.stop(name)
    }
    return this.deps.repository.remove(name)
  }

  // Unregisters every managed endpoint (shutdown path): stop live ones, then clear the store.
  async shutdownAll(): Promise<void> {
    const endpoints = await this.deps.repository.list()
    for (const endpoint of endpoints) {
      if (endpoint.state === ENDPOINT_STATE_LIVE || endpoint.state === ENDPOINT_STATE_STARTING) {
        try {
          await this.stop(endpoint.name)
        } catch {
          // Best effort on shutdown.
        }
      }
    }
  }

  // Builds the env handed to lifecycle scripts: HOST_PORT, SERVICE_DIR (a per-endpoint scratch
  // dir under the data root), and the credential VALUE by name (never logged or returned).
  private async buildScriptEnv(endpoint: ManagedEndpoint): Promise<Record<string, string>> {
    const env: Record<string, string> = {
      HOST_PORT: String(endpoint.port),
      SERVICE_DIR: join(this.deps.repository['options'].storageRoot, ENDPOINTS_DIR, endpoint.name)
    }
    if (endpoint.credentialName) {
      const value = await this.deps.resolveCredential(endpoint.credentialName)
      if (value) {
        // Mirror the reference env var naming (CREDENTIAL_NAME + _VALUE is explicit and
        // greppable for the script author).
        env.CREDENTIAL_VALUE = value
        env.CREDENTIAL_NAME = endpoint.credentialName
      }
    }
    // Ensure the service dir exists so scripts can cache models there.
    await mkdir(env.SERVICE_DIR, { recursive: true })
    return env
  }
}

const defaultRunScript = (
  script: string,
  env: Record<string, string>
): Promise<{ ok: boolean; error?: string }> =>
  new Promise((resolvePromise) => {
    const child = spawn('/bin/bash', ['-c', script], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-2000)
    })
    child.on('error', (error) => resolvePromise({ ok: false, error: error.message }))
    child.on('close', (code) => {
      resolvePromise(code === 0 ? { ok: true } : { ok: false, error: stderr.trim() || `exit ${code}` })
    })
  })

const defaultProbe = async (url: string): Promise<boolean> => {
  try {
    const response = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(2_000) })
    return response.ok
  } catch {
    return false
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolvePromise) => setTimeout(resolvePromise, ms))

const iso = (epochMs: number): string => new Date(epochMs).toISOString()
