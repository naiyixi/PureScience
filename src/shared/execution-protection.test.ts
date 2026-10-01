import { describe, expect, it } from 'vitest'

import {
  DEFAULT_REMOTE_UNPROTECTED_EXECUTION_POLICY,
  EXECUTION_PROTECTION_LEVELS,
  compareExecutionProtection,
  executionProtectionRank,
  isRemoteExecutionSurface,
  isRemoteUnprotectedExecutionPolicy,
  policyDeniesUnprotectedExecution,
  protectionEvidenceLine,
  protectionRepairSteps,
  rememberedApprovalCoversUnprotected,
  resolveExecutionProtection,
  type ExecutionProtectionInput
} from './execution-protection'

const localInput = (
  overrides: Partial<ExecutionProtectionInput> = {}
): ExecutionProtectionInput => ({
  surface: 'notebook',
  platform: 'darwin',
  networkAllowlistEnabled: true,
  osWriteGuardAvailable: true,
  capturedAt: 1_700_000_000_000,
  ...overrides
})

describe('resolveExecutionProtection — local surfaces', () => {
  it('reports os-sandbox only when both axes hold, and lists every applied layer', () => {
    const snapshot = resolveExecutionProtection(localInput())
    expect(snapshot.level).toBe('os-sandbox')
    expect(snapshot.scope).toEqual({ filesystem: 'runtime-write-protected', network: 'allowlist' })
    expect(snapshot.applied).toEqual([
      'managed-runtime-mutation-guard',
      'macos-seatbelt-runtime-write',
      'egress-allowlist'
    ])
    expect(snapshot.unmet).toEqual([])
  })

  it('drops to unprotected when the allowlist is switched off and names the missing axis', () => {
    const snapshot = resolveExecutionProtection(localInput({ networkAllowlistEnabled: false }))
    expect(snapshot.level).toBe('unprotected')
    // The write-guard is still in force: the downgrade must not erase a protection that is real.
    expect(snapshot.scope.filesystem).toBe('runtime-write-protected')
    expect(snapshot.scope.network).toBe('unrestricted')
    expect(snapshot.applied).toContain('macos-seatbelt-runtime-write')
    expect(snapshot.unmet.map((reason) => reason.code)).toEqual(['network-allowlist-disabled'])
    expect(
      compareExecutionProtection(snapshot.level, resolveExecutionProtection(localInput()).level)
    ).toBeGreaterThan(0)
  })

  it('reports network-allowlist when the macOS write-guard component is missing', () => {
    const snapshot = resolveExecutionProtection(localInput({ osWriteGuardAvailable: false }))
    expect(snapshot.level).toBe('network-allowlist')
    expect(snapshot.scope.filesystem).toBe('unrestricted')
    expect(snapshot.unmet.map((reason) => reason.code)).toEqual(['os-sandbox-component-missing'])
  })

  it('reports network-allowlist on platforms with no OS write-guard in this build', () => {
    const snapshot = resolveExecutionProtection(
      localInput({ platform: 'linux', osWriteGuardAvailable: false })
    )
    expect(snapshot.level).toBe('network-allowlist')
    expect(snapshot.unmet.map((reason) => reason.code)).toEqual(['os-sandbox-unavailable-platform'])
    expect(snapshot.applied).not.toContain('macos-seatbelt-runtime-write')
  })

  it('reports both gaps, in a stable order, when nothing protects the surface', () => {
    const snapshot = resolveExecutionProtection(
      localInput({
        platform: 'win32',
        osWriteGuardAvailable: false,
        networkAllowlistEnabled: false
      })
    )
    expect(snapshot.level).toBe('unprotected')
    expect(snapshot.unmet.map((reason) => reason.code)).toEqual([
      'network-allowlist-disabled',
      'os-sandbox-unavailable-platform'
    ])
    expect(snapshot.applied).toEqual(['managed-runtime-mutation-guard'])
  })
})

describe('resolveExecutionProtection — remote surfaces', () => {
  const remote = {
    providerId: 'ssh:biowulf',
    displayName: 'Biowulf',
    executionMode: 'slurm' as const
  }

  it.each(['background-job', 'remote-host'] as const)(
    'keeps %s unprotected even while the LOCAL allowlist is on',
    (surface) => {
      const snapshot = resolveExecutionProtection(
        localInput({ surface, networkAllowlistEnabled: true, remote })
      )
      // The local proxy filters this machine's child processes; a remote command's traffic is the
      // host's. Counting it here would be the exact overstatement the matrix exists to prevent.
      expect(snapshot.level).toBe('unprotected')
      expect(snapshot.scope).toEqual({ filesystem: 'unrestricted', network: 'unrestricted' })
      expect(snapshot.applied).toEqual([])
      expect(snapshot.unmet.map((reason) => reason.code)).toEqual([
        'remote-execution-has-no-local-protection'
      ])
      expect(snapshot.remote).toEqual(remote)
    }
  )

  it('omits the host block for local surfaces', () => {
    expect(resolveExecutionProtection(localInput()).remote).toBeUndefined()
  })

  it('classifies exactly the two remote surfaces', () => {
    expect(isRemoteExecutionSurface('notebook')).toBe(false)
    expect(isRemoteExecutionSurface('shell')).toBe(false)
    expect(isRemoteExecutionSurface('background-job')).toBe(true)
    expect(isRemoteExecutionSurface('remote-host')).toBe(true)
  })
})

describe('protectionRepairSteps', () => {
  it('gives no step when there is nothing to repair', () => {
    expect(protectionRepairSteps(resolveExecutionProtection(localInput()))).toEqual([])
  })

  it('points at the allowlist switch when egress filtering is the gap', () => {
    const steps = protectionRepairSteps(
      resolveExecutionProtection(localInput({ networkAllowlistEnabled: false }))
    )
    expect(steps.map((step) => step.code)).toEqual(['enable-network-allowlist'])
    expect(steps[0].detail.length).toBeGreaterThan(0)
  })

  it('states the platform limit instead of inventing an action that cannot work', () => {
    const steps = protectionRepairSteps(
      resolveExecutionProtection(localInput({ platform: 'linux', osWriteGuardAvailable: false }))
    )
    expect(steps.map((step) => step.code)).toEqual(['platform-has-no-os-sandbox'])
  })

  it('tells the user to run locally when the gap is the remote surface itself', () => {
    const steps = protectionRepairSteps(
      resolveExecutionProtection(localInput({ surface: 'remote-host' }))
    )
    expect(steps.map((step) => step.code)).toEqual(['run-locally'])
  })
})

describe('protectionEvidenceLine', () => {
  it('is identical for identical protection state and carries every axis', () => {
    const first = protectionEvidenceLine(resolveExecutionProtection(localInput()))
    const second = protectionEvidenceLine(resolveExecutionProtection(localInput()))
    expect(first).toBe(second)
    expect(first).toBe(
      'execution-protection:v1 surface=notebook level=os-sandbox platform=darwin ' +
        'filesystem=runtime-write-protected network=allowlist ' +
        'applied=egress-allowlist+macos-seatbelt-runtime-write+managed-runtime-mutation-guard unmet=none'
    )
  })

  it('names the unmet codes rather than only the level, so a downgrade is auditable', () => {
    const line = protectionEvidenceLine(
      resolveExecutionProtection(localInput({ networkAllowlistEnabled: false }))
    )
    expect(line).toContain('level=unprotected')
    expect(line).toContain('unmet=network-allowlist-disabled')
    expect(line).toContain('filesystem=runtime-write-protected')
  })
})

describe('level ordering', () => {
  it('ranks the three levels strongest first', () => {
    expect(EXECUTION_PROTECTION_LEVELS.map(executionProtectionRank)).toEqual([0, 1, 2])
    expect(compareExecutionProtection('os-sandbox', 'unprotected')).toBeLessThan(0)
    expect(compareExecutionProtection('unprotected', 'network-allowlist')).toBeGreaterThan(0)
    expect(compareExecutionProtection('network-allowlist', 'network-allowlist')).toBe(0)
  })
})

describe('remote unprotected execution policy', () => {
  it('defaults to refusing an unprotected run rather than asking or silently remembering', () => {
    expect(DEFAULT_REMOTE_UNPROTECTED_EXECUTION_POLICY).toBe('deny')
    // The default must also close the two looser doors: it may not let a remembered approval cover the
    // run, and it must refuse the run outright instead of leaving it to a per-run answer.
    expect(rememberedApprovalCoversUnprotected(DEFAULT_REMOTE_UNPROTECTED_EXECUTION_POLICY)).toBe(
      false
    )
    expect(
      policyDeniesUnprotectedExecution(DEFAULT_REMOTE_UNPROTECTED_EXECUTION_POLICY, 'unprotected')
    ).toBe(true)
  })

  it('only lets remembered approvals cover unprotected runs when the user opted in', () => {
    expect(rememberedApprovalCoversUnprotected('remembered')).toBe(true)
    expect(rememberedApprovalCoversUnprotected('deny')).toBe(false)
    expect(rememberedApprovalCoversUnprotected('confirm')).toBe(false)
  })

  it('denies unprotected runs only under the deny policy', () => {
    expect(policyDeniesUnprotectedExecution('deny', 'unprotected')).toBe(true)
    expect(policyDeniesUnprotectedExecution('deny', 'os-sandbox')).toBe(false)
    expect(policyDeniesUnprotectedExecution('confirm', 'unprotected')).toBe(false)
  })

  it('rejects unknown stored policy values instead of guessing', () => {
    expect(isRemoteUnprotectedExecutionPolicy('confirm')).toBe(true)
    expect(isRemoteUnprotectedExecutionPolicy('remembered')).toBe(true)
    expect(isRemoteUnprotectedExecutionPolicy('deny')).toBe(true)
    expect(isRemoteUnprotectedExecutionPolicy('silent')).toBe(false)
    expect(isRemoteUnprotectedExecutionPolicy(undefined)).toBe(false)
  })
})
