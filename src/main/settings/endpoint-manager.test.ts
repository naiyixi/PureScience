// Endpoint manager lifecycle tests: start/stop state machine, readiness probing, script hash
// approval gate, credential env injection, and free-port allocation.

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { EndpointManager } from './endpoint-manager'
import { EndpointRepository } from './endpoint-repository'

let root: string
let repository: EndpointRepository
let manager: EndpointManager

const register = {
  name: 'esm-fold',
  url: 'http://127.0.0.1:20001',
  skillName: 'esm-runbook',
  startScript: 'echo start',
  stopScript: 'echo stop',
  livePath: '/health/ready'
}

type ManagerOverrides = {
  runScript?: (script: string, env: Record<string, string>) => Promise<{ ok: boolean; error?: string }>
  probe?: (url: string) => Promise<boolean>
  isPortBound?: (port: number) => Promise<boolean>
  resolveCredential?: (name: string) => Promise<string | undefined>
  timeoutMs?: number
  pollMs?: number
}

const makeManager = (overrides: ManagerOverrides = {}): void => {
  manager = new EndpointManager({
    repository,
    resolveCredential: async () => undefined,
    ...overrides
  })
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'endpoint-mgr-'))
  repository = new EndpointRepository({ storageRoot: root })
  await repository.upsert(register)
  // Approve the script hash so start is allowed.
  const { endpoint } = await repository.upsert(register)
  await repository.approveHash(endpoint.approvedScriptHash)
  makeManager()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('EndpointManager', () => {
  it('rejects starting an unknown endpoint', async () => {
    await expect(manager.start('nope')).rejects.toThrow(/No managed endpoint named/)
  })

  it('refuses to start an unapproved endpoint (license-gate analog)', async () => {
    const repo2 = new EndpointRepository({ storageRoot: root })
    await repo2.upsert({
      ...register,
      name: 'unapproved-svc',
      url: 'http://127.0.0.1:20002',
      startScript: 'echo different-start'
    })
    const mgr = new EndpointManager({ repository: repo2, resolveCredential: async () => undefined })
    await expect(mgr.start('unapproved-svc')).rejects.toThrow(/has not been approved/)
  })

  it('runs the start script, probes readiness, and reaches live', async () => {
    const runScript = vi.fn(async () => ({ ok: true }))
    const probe = vi.fn(async () => true)
    makeManager({ runScript, probe })

    const { endpoint } = await manager.start('esm-fold')
    expect(runScript).toHaveBeenCalledTimes(1)
    expect(probe).toHaveBeenCalled()
    expect(endpoint.state).toBe('live')
    expect(endpoint.transcript).toContain('ready')
  })

  it('fails (failed state) when the start script exits non-zero', async () => {
    const runScript = vi.fn(async () => ({ ok: false, error: 'docker daemon unreachable' }))
    makeManager({ runScript })

    const { endpoint } = await manager.start('esm-fold')
    expect(endpoint.state).toBe('failed')
    expect(endpoint.lastError).toContain('docker daemon unreachable')
  })

  it('fails when readiness never arrives and unwinds with the stop script', async () => {
    const runScript = vi.fn(async () => ({ ok: true }))
    const probe = vi.fn(async () => false)
    makeManager({ runScript, probe, timeoutMs: 50, pollMs: 10 })

    const { endpoint } = await manager.start('esm-fold')
    expect(endpoint.state).toBe('failed')
    expect(endpoint.lastError).toContain('readiness probe timed out')
    // The stop script was run to unwind the half-started service.
    expect(runScript).toHaveBeenCalledTimes(2)
  })

  it('start is idempotent for a live endpoint', async () => {
    const runScript = vi.fn(async () => ({ ok: true }))
    const probe = vi.fn(async () => true)
    makeManager({ runScript, probe })

    await manager.start('esm-fold')
    const { endpoint } = await manager.start('esm-fold')
    expect(endpoint.state).toBe('live')
    expect(runScript).toHaveBeenCalledTimes(1)
  })

  it('stop runs the stop script and returns to stopped', async () => {
    const runScript = vi.fn(async () => ({ ok: true }))
    const probe = vi.fn(async () => true)
    makeManager({ runScript, probe })

    await manager.start('esm-fold')
    const { endpoint } = await manager.stop('esm-fold')
    expect(endpoint.state).toBe('stopped')
    expect(runScript).toHaveBeenCalledTimes(2) // start + stop
  })

  it('unregister stops a live endpoint first, then removes it', async () => {
    const runScript = vi.fn(async () => ({ ok: true }))
    const probe = vi.fn(async () => true)
    makeManager({ runScript, probe })

    await manager.start('esm-fold')
    expect(await manager.unregister('esm-fold')).toBe(true)
    expect(await repository.get('esm-fold')).toBeNull()
  })

  it('freePort skips ports owned by other endpoints and bound ports', async () => {
    // Port 20001 is owned by esm-fold; isPortBound claims 20001-20009 are all bound.
    const isPortBound = vi.fn(async (port: number) => port < 20010)
    makeManager({ isPortBound })
    const { port } = await manager.freePort()
    expect(port).toBeGreaterThanOrEqual(20010)
    expect(isPortBound).toHaveBeenCalled()
  })

  it('freePort throws when the whole range is taken', async () => {
    const isPortBound = vi.fn(async () => true)
    makeManager({ isPortBound })
    await expect(manager.freePort()).rejects.toThrow(/No free port/)
  })

  it('injects the credential VALUE into the start script env by name', async () => {
    const seen: Record<string, string>[] = []
    const runScript = vi.fn(async (_script: string, env: Record<string, string>) => {
      seen.push(env)
      return { ok: true }
    })
    const probe = vi.fn(async () => true)
    manager = new EndpointManager({
      repository,
      resolveCredential: async (name) => (name === 'NVIDIA_API_KEY' ? 'sk-secret-value' : undefined),
      runScript,
      probe
    })
    await repository.upsert({ ...register, credentialName: 'NVIDIA_API_KEY' })
    await manager.start('esm-fold')
    expect(seen[0]?.HOST_PORT).toBe('20001')
    expect(seen[0]?.CREDENTIAL_NAME).toBe('NVIDIA_API_KEY')
    expect(seen[0]?.CREDENTIAL_VALUE).toBe('sk-secret-value')
    expect(seen[0]?.SERVICE_DIR).toContain('esm-fold')
  })

  it('shutdownAll stops every live endpoint best-effort', async () => {
    const runScript = vi.fn(async () => ({ ok: true }))
    const probe = vi.fn(async () => true)
    makeManager({ runScript, probe })
    await manager.start('esm-fold')
    await manager.shutdownAll()
    expect((await repository.get('esm-fold'))?.state).toBe('stopped')
  })
})
