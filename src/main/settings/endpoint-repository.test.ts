// Endpoint repository persistence tests: registration validation, hash allowlist approval,
// state transitions, and cross-session global listing.

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { EndpointRepository, EndpointValidationError } from './endpoint-repository'

let root: string
let repository: EndpointRepository

const register = {
  name: 'esm-fold',
  url: 'http://127.0.0.1:20001',
  skillName: 'esm-runbook',
  startScript:
    'docker inspect esm-fold && docker start esm-fold || docker run -d --name esm-fold -p $HOST_PORT:80 esm:latest',
  stopScript: 'docker stop esm-fold',
  livePath: '/health/ready'
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'endpoint-repo-'))
  repository = new EndpointRepository({ storageRoot: root })
})

afterEach(() => {
  // no-op cleanup; tmpdir is ephemeral
})

describe('EndpointRepository', () => {
  it('persists a registration with a script hash and newlyApproved=true', async () => {
    const { endpoint, newlyApproved } = await repository.upsert(register)
    expect(newlyApproved).toBe(true)
    expect(endpoint.name).toBe('esm-fold')
    expect(endpoint.port).toBe(20001)
    expect(endpoint.state).toBe('stopped')
    expect(endpoint.approvedScriptHash).toMatch(/^[0-9a-f]{64}$/)

    const listed = await repository.list()
    expect(listed).toHaveLength(1)
    expect(listed[0]?.url).toBe('http://127.0.0.1:20001')
  })

  it('rejects names outside [a-z0-9-]', async () => {
    await expect(repository.upsert({ ...register, name: 'Bad Name' })).rejects.toThrow(
      EndpointValidationError
    )
    await expect(repository.upsert({ ...register, name: 'UPPER' })).rejects.toThrow(
      EndpointValidationError
    )
  })

  it('rejects localhost URLs (must be literal 127.0.0.1)', async () => {
    await expect(repository.upsert({ ...register, url: 'http://localhost:20001' })).rejects.toThrow(
      /127\.0\.0\.1/
    )
  })

  it('rejects ports outside the managed range', async () => {
    await expect(repository.upsert({ ...register, url: 'http://127.0.0.1:8080' })).rejects.toThrow(
      /20000-29999/
    )
  })

  it('rejects a second endpoint owning the same port', async () => {
    await repository.upsert(register)
    await expect(repository.upsert({ ...register, name: 'other-service' })).rejects.toThrow(
      /owned by another endpoint/
    )
  })

  it('re-registering identical scripts is silent (newlyApproved=false after approval)', async () => {
    await repository.upsert(register)
    // Approve the hash as the user would in the panel.
    const { endpoint } = await repository.upsert(register)
    await repository.approveHash(endpoint.approvedScriptHash)
    const { newlyApproved } = await repository.upsert(register)
    expect(newlyApproved).toBe(false)
    expect(await repository.isHashApproved(endpoint.approvedScriptHash)).toBe(true)
  })

  it('any script byte change forces a fresh approval', async () => {
    const first = await repository.upsert(register)
    await repository.approveHash(first.endpoint.approvedScriptHash)
    const changed = await repository.upsert({
      ...register,
      stopScript: 'docker stop esm-fold && echo bye'
    })
    expect(changed.newlyApproved).toBe(true)
  })

  it('tracks registeredBy for audit', async () => {
    const { endpoint } = await repository.upsert(register, 'session-42')
    expect(endpoint.registeredBy).toBe('session-42')
  })

  it('transitions state with timestamps and lastError', async () => {
    await repository.upsert(register)
    const starting = await repository.setState('esm-fold', 'starting', {
      transcript: '[t0] start requested'
    })
    expect(starting?.state).toBe('starting')
    const failed = await repository.setState('esm-fold', 'failed', {
      error: 'readiness timeout',
      transcript: '[t1] failed'
    })
    expect(failed?.state).toBe('failed')
    expect(failed?.lastError).toBe('readiness timeout')
    expect(failed?.stateChangedAt).not.toBeNull()
  })

  it('setStateIfStill only applies when the endpoint is in the expected state', async () => {
    await repository.upsert(register)
    await repository.setState('esm-fold', 'starting')
    // A concurrent stop already moved it to stopped — the stale start completion must not clobber.
    await repository.setState('esm-fold', 'stopped')
    const result = await repository.setStateIfStill('esm-fold', 'starting', 'live')
    expect(result).toBeNull()
    expect((await repository.get('esm-fold'))?.state).toBe('stopped')
  })

  it('clearFailure resets failed to stopped and clears the error', async () => {
    await repository.upsert(register)
    await repository.setState('esm-fold', 'failed', { error: 'boom' })
    const cleared = await repository.clearFailure('esm-fold')
    expect(cleared?.state).toBe('stopped')
    expect(cleared?.lastError).toBeNull()
  })

  it('removes an endpoint', async () => {
    await repository.upsert(register)
    expect(await repository.remove('esm-fold')).toBe(true)
    expect(await repository.remove('esm-fold')).toBe(false)
    expect(await repository.list()).toHaveLength(0)
  })

  it('persists across instances (file-backed)', async () => {
    await repository.upsert(register)
    const reloaded = new EndpointRepository({ storageRoot: root })
    const endpoints = await reloaded.list()
    expect(endpoints).toHaveLength(1)
    expect(endpoints[0]?.name).toBe('esm-fold')
    const raw = JSON.parse(
      readFileSync(join(root, '.endpoints', 'endpoints.json'), 'utf8')
    ) as unknown
    expect(Array.isArray(raw)).toBe(true)
  })
})
