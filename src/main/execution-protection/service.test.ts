import { describe, expect, it } from 'vitest'

import {
  OS_WRITE_GUARD_COMPONENT,
  createExecutionProtectionService,
  type ExecutionProtectionServiceDeps
} from './service'

const service = (
  overrides: Partial<ExecutionProtectionServiceDeps> = {}
): ReturnType<typeof createExecutionProtectionService> =>
  createExecutionProtectionService({
    platform: 'darwin',
    componentPresent: (path) => path === OS_WRITE_GUARD_COMPONENT,
    readEgress: () => ({ enabled: true, groups: {}, customDomains: [] }),
    now: () => 1_700_000_000_000,
    ...overrides
  })

describe('osWriteGuardStatus', () => {
  it('claims the guard only on darwin with the component present', () => {
    expect(service().osWriteGuardStatus()).toEqual({
      platform: 'darwin',
      component: OS_WRITE_GUARD_COMPONENT,
      componentPresent: true,
      available: true
    })
  })

  it('reports a missing component instead of letting the spawn fail later', () => {
    const status = service({ componentPresent: () => false }).osWriteGuardStatus()
    expect(status.componentPresent).toBe(false)
    expect(status.available).toBe(false)
  })

  it('does not claim the guard on a platform whose spawn wrapper ignores it', () => {
    const status = service({ platform: 'linux' }).osWriteGuardStatus()
    // The component path exists on this machine, but `protectManagedRuntimeWrites` is a no-op off
    // darwin, so the level must not be raised by its presence.
    expect(status.componentPresent).toBe(true)
    expect(status.available).toBe(false)
  })
})

describe('snapshot', () => {
  it('derives the local level from the persisted allowlist switch', async () => {
    const on = await service().snapshot('notebook')
    expect(on.level).toBe('os-sandbox')
    const off = await service({
      readEgress: () => ({ enabled: false, groups: {}, customDomains: [] })
    }).snapshot('notebook')
    expect(off.level).toBe('unprotected')
    expect(off.unmet.map((reason) => reason.code)).toEqual(['network-allowlist-disabled'])
    expect(off.scope.filesystem).toBe('runtime-write-protected')
  })

  it('treats missing egress settings as an unfiltered network rather than guessing', async () => {
    const snapshot = await service({ readEgress: () => undefined }).snapshot('shell')
    expect(snapshot.level).toBe('unprotected')
    expect(snapshot.scope.network).toBe('unrestricted')
  })

  it('records the host on remote snapshots', async () => {
    const snapshot = await service().snapshot('remote-host', {
      providerId: 'ssh:biowulf',
      displayName: 'Biowulf',
      executionMode: 'slurm'
    })
    expect(snapshot.level).toBe('unprotected')
    expect(snapshot.remote).toEqual({
      providerId: 'ssh:biowulf',
      displayName: 'Biowulf',
      executionMode: 'slurm'
    })
  })
})

describe('matrix', () => {
  it('reports every execution surface in a stable order', async () => {
    const matrix = await service().matrix()
    expect(matrix.surfaces.map((row) => row.surface)).toEqual([
      'notebook',
      'shell',
      'background-job',
      'remote-host'
    ])
    expect(matrix.osWriteGuard.available).toBe(true)
    expect(matrix.networkAllowlist.enabled).toBe(true)
    expect(matrix.capturedAt).toBe(1_700_000_000_000)
  })

  it('leaves remote rows host-agnostic so no host can be mistaken for safer', async () => {
    const matrix = await service().matrix()
    const remote = matrix.surfaces.filter(
      (row) => row.surface === 'background-job' || row.surface === 'remote-host'
    )
    expect(remote).toHaveLength(2)
    for (const row of remote) {
      expect(row.level).toBe('unprotected')
      expect(row.remote).toBeUndefined()
      expect(row.applied).toEqual([])
    }
  })

  it('defaults the remote policy to refusing unprotected runs when nothing is stored', async () => {
    const matrix = await service().matrix()
    expect(matrix.remoteUnprotectedPolicy).toBe('deny')
    expect(await service().remoteUnprotectedPolicy()).toBe('deny')
  })

  it('reports the stored remote policy when one is set', async () => {
    const stored = service({ readRemoteUnprotectedPolicy: () => 'deny' })
    expect((await stored.matrix()).remoteUnprotectedPolicy).toBe('deny')
    expect(await stored.remoteUnprotectedPolicy()).toBe('deny')
  })
})
