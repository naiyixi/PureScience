// Endpoint IPC owner tests: the settings panel's list has to say whether each endpoint's CURRENT script
// bytes are approved, because start refuses an unapproved hash. Without that flag the panel can only
// offer a play button that fails.

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeEach, describe, expect, it } from 'vitest'

import type { EndpointManager } from './endpoint-manager'
import { createEndpointCommandOwner } from './endpoint-ipc'
import { EndpointRepository } from './endpoint-repository'

const register = {
  name: 'esm-fold',
  url: 'http://127.0.0.1:20001',
  skillName: 'esm-runbook',
  startScript: 'echo start',
  stopScript: 'echo stop',
  livePath: '/health/ready'
}

let repository: EndpointRepository
// listAll only reads the repository, so the manager is never exercised here.
const managerStub = {} as EndpointManager

beforeEach(() => {
  repository = new EndpointRepository({ storageRoot: mkdtempSync(join(tmpdir(), 'endpoint-ipc-')) })
})

describe('endpoint listAll', () => {
  it('marks a freshly registered endpoint as unapproved and flips once its hash is pinned', async () => {
    const owner = createEndpointCommandOwner(repository, managerStub)
    const { endpoint } = await repository.upsert(register)

    const before = await owner.listAll()
    expect(before).toHaveLength(1)
    expect(before[0].approved).toBe(false)

    await repository.approveHash(endpoint.approvedScriptHash)

    const after = await owner.listAll()
    expect(after).toHaveLength(1)
    expect(after[0].approved).toBe(true)
  })

  it('keeps every stored field alongside the approval flag', async () => {
    const owner = createEndpointCommandOwner(repository, managerStub)
    const { endpoint } = await repository.upsert(register)

    const [view] = await owner.listAll()
    expect(view.name).toBe(endpoint.name)
    expect(view.url).toBe(endpoint.url)
    expect(view.port).toBe(endpoint.port)
    expect(view.startScript).toBe(register.startScript)
    expect(view.stopScript).toBe(register.stopScript)
    expect(view.livePath).toBe(register.livePath)
    expect(view.approvedScriptHash).toBe(endpoint.approvedScriptHash)
  })

  it('returns an empty list rather than throwing when nothing is registered', async () => {
    const owner = createEndpointCommandOwner(repository, managerStub)
    await expect(owner.listAll()).resolves.toEqual([])
  })
})
