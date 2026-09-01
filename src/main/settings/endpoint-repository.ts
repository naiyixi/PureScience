// Managed-endpoint persistence: the store behind endpoint_register / endpoint_status /
// endpoint_start/stop and the settings panel. Managed endpoints are GLOBAL resources (a local
// model service is one machine-wide thing, shared by every session), so unlike routines they
// live in a single JSON file under the data root rather than per-session. A second file keeps
// the approved-script hash allowlist: a registration whose script bytes match an already
// approved hash re-approves silently (the reference design's "byte-identical is silent
// forever"), while any byte change forces a fresh approval card. The main process is the
// single writer; every mutation goes through atomic write (temp file + rename).

import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type {
  EndpointRegisterRequest,
  EndpointState,
  ManagedEndpoint
} from '../../shared/endpoint'
import {
  ENDPOINT_PORT_RANGE_END,
  ENDPOINT_PORT_RANGE_START,
  ENDPOINT_STATE_STOPPED,
  endpointScriptBytes
} from '../../shared/endpoint'

const ENDPOINTS_DIR = '.endpoints'
const ENDPOINTS_FILE = 'endpoints.json'
const APPROVALS_FILE = 'approvals.json'

export class EndpointValidationError extends Error {
  readonly code:
    | 'invalid_name'
    | 'invalid_url'
    | 'port_taken'
    | 'port_out_of_range'
    | 'empty_script'
    | 'not_found'

  constructor(code: EndpointValidationError['code'], message: string) {
    super(message)
    this.name = 'EndpointValidationError'
    this.code = code
  }
}

// Local loopback only; 'localhost' is rejected (rootless docker resolves it to ::1 while the
// container publishes on IPv4). HTTPS loopback is not a thing; require http.
const URL_PATTERN = /^http:\/\/127\.0\.0\.1:(\d+)(\/[^\s]*)?$/
const NAME_PATTERN = /^[a-z0-9-]{1,64}$/

export type EndpointRepositoryOptions = {
  storageRoot: string
  now?: () => number
}

export class EndpointRepository {
  private readonly now: () => number

  constructor(private readonly options: EndpointRepositoryOptions) {
    this.now = options.now ?? (() => Date.now())
  }

  private endpointsPath(): string {
    return join(this.options.storageRoot, ENDPOINTS_DIR, ENDPOINTS_FILE)
  }

  private approvalsPath(): string {
    return join(this.options.storageRoot, ENDPOINTS_DIR, APPROVALS_FILE)
  }

  private async readEndpoints(): Promise<ManagedEndpoint[]> {
    try {
      const raw = await readFile(this.endpointsPath(), 'utf8')
      const parsed = JSON.parse(raw) as unknown
      if (Array.isArray(parsed)) return parsed.filter(isManagedEndpoint)
      return []
    } catch {
      return []
    }
  }

  private async writeEndpoints(endpoints: ManagedEndpoint[]): Promise<void> {
    const target = this.endpointsPath()
    await mkdir(dirname(target), { recursive: true })
    const temp = `${target}.${crypto.randomUUID()}.tmp`
    await writeFile(temp, JSON.stringify(endpoints, null, 2), { encoding: 'utf8', flag: 'wx' })
    await rename(temp, target)
  }

  private async readApprovals(): Promise<string[]> {
    try {
      const raw = await readFile(this.approvalsPath(), 'utf8')
      const parsed = JSON.parse(raw) as unknown
      if (Array.isArray(parsed)) return parsed.filter((x): x is string => typeof x === 'string')
      return []
    } catch {
      return []
    }
  }

  private async writeApprovals(hashes: string[]): Promise<void> {
    const target = this.approvalsPath()
    await mkdir(dirname(target), { recursive: true })
    const temp = `${target}.${crypto.randomUUID()}.tmp`
    await writeFile(temp, JSON.stringify(hashes, null, 2), { encoding: 'utf8', flag: 'wx' })
    await rename(temp, target)
  }

  // Validates and persists a registration. Returns { endpoint, newlyApproved } where
  // newlyApproved is true iff the script set's hash was NOT already in the allowlist (the
  // caller must show an approval card in that case; the hash is pinned only after approval).
  async upsert(
    request: EndpointRegisterRequest,
    registeredBy?: string
  ): Promise<{
    endpoint: ManagedEndpoint
    newlyApproved: boolean
  }> {
    const name = validateName(request.name)
    const url = validateUrl(request.url)
    const port = parsePort(request.url)
    const skillName = request.skillName.trim()
    if (!skillName) {
      throw new EndpointValidationError('empty_script', 'skillName must not be empty')
    }
    const startScript = request.startScript.trim()
    const stopScript = request.stopScript.trim()
    if (!startScript || !stopScript) {
      throw new EndpointValidationError('empty_script', 'start and stop scripts must not be empty')
    }
    const livePath = normalizeLivePath(request.livePath)
    const now = this.now()

    const endpoints = await this.readEndpoints()
    const portTaken = endpoints.some(
      (endpoint) => endpoint.port === port && endpoint.name !== name
    )
    if (portTaken) {
      throw new EndpointValidationError('port_taken', `Port ${port} is owned by another endpoint.`)
    }

    const hash = scriptHash({ startScript, stopScript, livePath })
    const approvals = await this.readApprovals()
    const newlyApproved = !approvals.includes(hash)

    const existing = endpoints.find((endpoint) => endpoint.name === name)
    const endpoint: ManagedEndpoint = {
      name,
      url,
      port,
      credentialName: request.credentialName?.trim() || undefined,
      skillName,
      startScript,
      stopScript,
      livePath,
      approvedScriptHash: hash,
      registeredBy: registeredBy ?? existing?.registeredBy,
      state: ENDPOINT_STATE_STOPPED,
      stateChangedAt: now,
      lastError: null,
      transcript: null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    }
    const next = existing
      ? endpoints.map((entry) => (entry.name === name ? endpoint : entry))
      : [...endpoints, endpoint]
    await this.writeEndpoints(next)
    return { endpoint, newlyApproved }
  }

  // Pins a script hash into the allowlist AFTER the user approved the card. Subsequent
  // registrations with identical bytes skip the card.
  async approveHash(hash: string): Promise<void> {
    const approvals = await this.readApprovals()
    if (!approvals.includes(hash)) {
      await this.writeApprovals([...approvals, hash])
    }
  }

  async isHashApproved(hash: string): Promise<boolean> {
    const approvals = await this.readApprovals()
    return approvals.includes(hash)
  }

  async get(name: string): Promise<ManagedEndpoint | null> {
    const endpoints = await this.readEndpoints()
    return endpoints.find((endpoint) => endpoint.name === name) ?? null
  }

  async list(): Promise<ManagedEndpoint[]> {
    return this.readEndpoints()
  }

  async setState(
    name: string,
    state: EndpointState,
    extra: { error?: string | null; transcript?: string | null } = {}
  ): Promise<ManagedEndpoint | null> {
    const endpoints = await this.readEndpoints()
    const index = endpoints.findIndex((endpoint) => endpoint.name === name)
    if (index === -1) return null
    const now = this.now()
    const previous = endpoints[index]
    const updated: ManagedEndpoint = {
      ...previous,
      state,
      stateChangedAt: now,
      lastError: extra.error !== undefined ? extra.error : previous.lastError,
      // Transcript carries the rolling tail of lifecycle events.
      transcript:
        extra.transcript !== undefined
          ? trimTranscript(extra.transcript)
          : previous.transcript,
      updatedAt: now
    }
    endpoints[index] = updated
    await this.writeEndpoints(endpoints)
    return updated
  }

  // Conditional state transition: only applies when the endpoint is still in `expected`.
  // Prevents a slow start from clobbering a concurrent stop (and vice versa).
  async setStateIfStill(
    name: string,
    expected: EndpointState,
    state: EndpointState,
    extra: { error?: string | null; transcript?: string | null } = {}
  ): Promise<ManagedEndpoint | null> {
    const endpoints = await this.readEndpoints()
    const index = endpoints.findIndex(
      (endpoint) => endpoint.name === name && endpoint.state === expected
    )
    if (index === -1) return null
    const now = this.now()
    const previous = endpoints[index]
    const updated: ManagedEndpoint = {
      ...previous,
      state,
      stateChangedAt: now,
      lastError: extra.error !== undefined ? extra.error : previous.lastError,
      transcript:
        extra.transcript !== undefined
          ? trimTranscript(extra.transcript)
          : previous.transcript,
      updatedAt: now
    }
    endpoints[index] = updated
    await this.writeEndpoints(endpoints)
    return updated
  }

  // failed → stopped, clearing the error so a retry starts clean (mirrors the reference
  // clearFailure transition).
  async clearFailure(name: string): Promise<ManagedEndpoint | null> {
    const endpoints = await this.readEndpoints()
    const index = endpoints.findIndex(
      (endpoint) => endpoint.name === name && endpoint.state === 'failed'
    )
    if (index === -1) return null
    const now = this.now()
    const previous = endpoints[index]
    const updated: ManagedEndpoint = {
      ...previous,
      state: 'stopped',
      stateChangedAt: now,
      lastError: null,
      transcript: null,
      updatedAt: now
    }
    endpoints[index] = updated
    await this.writeEndpoints(endpoints)
    return updated
  }

  async remove(name: string): Promise<boolean> {
    const endpoints = await this.readEndpoints()
    const next = endpoints.filter((endpoint) => endpoint.name !== name)
    if (next.length === endpoints.length) return false
    await this.writeEndpoints(next)
    return true
  }
}

const validateName = (name: string): string => {
  const trimmed = name.trim()
  if (!NAME_PATTERN.test(trimmed)) {
    throw new EndpointValidationError(
      'invalid_name',
      'name must be 1-64 chars of [a-z0-9-] (lowercase, hyphens allowed).'
    )
  }
  return trimmed
}

const validateUrl = (url: string): string => {
  const trimmed = url.trim()
  const match = URL_PATTERN.exec(trimmed)
  if (!match) {
    throw new EndpointValidationError(
      'invalid_url',
      'url must be http://127.0.0.1:<port>[/path] — the literal IPv4 loopback. ' +
        'localhost is rejected (rootless docker resolves it to ::1).'
    )
  }
  return trimmed
}

const parsePort = (url: string): number => {
  const match = URL_PATTERN.exec(url.trim())
  const port = match ? Number(match[1]) : NaN
  if (!Number.isInteger(port) || port < ENDPOINT_PORT_RANGE_START || port > ENDPOINT_PORT_RANGE_END) {
    throw new EndpointValidationError(
      'port_out_of_range',
      `port must be an integer in ${ENDPOINT_PORT_RANGE_START}-${ENDPOINT_PORT_RANGE_END}.`
    )
  }
  return port
}

const normalizeLivePath = (livePath: string): string => {
  const trimmed = livePath.trim()
  if (!trimmed) return '/health/ready'
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`
}

export function scriptHash(scripts: {
  startScript: string
  stopScript: string
  livePath: string
}): string {
  return createHash('sha256').update(endpointScriptBytes(scripts)).digest('hex')
}

const trimTranscript = (transcript: string | null): string | null => {
  if (!transcript) return null
  // Keep the last ~2 KB of lifecycle events.
  if (transcript.length <= 2048) return transcript
  return transcript.slice(-2048)
}

const isManagedEndpoint = (value: unknown): value is ManagedEndpoint => {
  if (typeof value !== 'object' || value === null) return false
  const endpoint = value as Record<string, unknown>
  return (
    typeof endpoint.name === 'string' &&
    typeof endpoint.url === 'string' &&
    typeof endpoint.port === 'number' &&
    typeof endpoint.skillName === 'string' &&
    typeof endpoint.startScript === 'string' &&
    typeof endpoint.stopScript === 'string' &&
    typeof endpoint.livePath === 'string' &&
    typeof endpoint.approvedScriptHash === 'string' &&
    typeof endpoint.state === 'string'
  )
}
