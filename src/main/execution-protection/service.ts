// Main-process owner of the execution protection level. It is the single place that turns live
// machine state into a snapshot, so the matrix the user reads before a run and the snapshot a run
// persists afterwards are produced by one function from one set of inputs.
//
// What it probes and what it deliberately does NOT probe:
//  - It reads the network axis from the persisted egress allowlist. It never re-derives network
//    policy: the filtering proxy is the only mechanism that exists, so the level reports exactly it.
//  - It checks that the OS write-guard component the macOS spawn wrapper relies on is actually
//    present. `protectManagedRuntimeWrites` wraps the invocation with `/usr/bin/sandbox-exec`
//    without testing for it, so a machine missing that binary would fail at spawn instead of
//    reporting a level; probing here turns that into a named gap.
//  - It does not invent isolation the build does not ship (no native sandbox components, no claims
//    about a compute host's scheduler environment).

import { existsSync } from 'node:fs'

import type { EgressSettings } from '../../shared/egress'
import {
  DEFAULT_REMOTE_UNPROTECTED_EXECUTION_POLICY,
  resolveExecutionProtection,
  type ExecutionProtectionSnapshot,
  type ExecutionSurface,
  type RemoteUnprotectedExecutionPolicy
} from '../../shared/execution-protection'

// The component the macOS write-guard spawn wrapper executes. Kept in sync with
// notebook/managed-runtime-guard `protectManagedRuntimeWrites`.
export const OS_WRITE_GUARD_COMPONENT = '/usr/bin/sandbox-exec'

export type OsWriteGuardStatus = {
  platform: string
  component: string
  componentPresent: boolean
  // True only for a platform whose spawn paths apply the guard AND whose component is present.
  available: boolean
}

export type ExecutionProtectionMatrix = {
  platform: string
  capturedAt: number
  osWriteGuard: OsWriteGuardStatus
  networkAllowlist: { enabled: boolean }
  // One row per execution surface. Remote rows carry no host block: the level of a remote execution
  // does not depend on which host it is, so per-host duplication would only invite the reader to
  // think some host is safer than another.
  surfaces: ExecutionProtectionSnapshot[]
  remoteUnprotectedPolicy: RemoteUnprotectedExecutionPolicy
}

export type RemoteExecutionTarget = {
  providerId: string
  displayName: string
  executionMode: 'direct_ssh' | 'slurm'
}

export type ExecutionProtectionServiceDeps = {
  platform?: NodeJS.Platform
  // Injectable so tests do not depend on this machine's filesystem.
  componentPresent?: (path: string) => boolean
  readEgress: () => EgressSettings | undefined | Promise<EgressSettings | undefined>
  // Absent means the default policy (ask explicitly) rather than a silent older behavior.
  readRemoteUnprotectedPolicy?: () =>
    | RemoteUnprotectedExecutionPolicy
    | undefined
    | Promise<RemoteUnprotectedExecutionPolicy | undefined>
  now?: () => number
}

const SURFACES: readonly ExecutionSurface[] = ['notebook', 'shell', 'background-job', 'remote-host']

class ExecutionProtectionService {
  private readonly platform: NodeJS.Platform
  private readonly componentPresent: (path: string) => boolean
  private readonly readEgress: ExecutionProtectionServiceDeps['readEgress']
  private readonly readPolicy: ExecutionProtectionServiceDeps['readRemoteUnprotectedPolicy']
  private readonly now: () => number

  constructor(deps: ExecutionProtectionServiceDeps) {
    this.platform = deps.platform ?? process.platform
    this.componentPresent = deps.componentPresent ?? existsSync
    this.readEgress = deps.readEgress
    this.readPolicy = deps.readRemoteUnprotectedPolicy
    this.now = deps.now ?? (() => Date.now())
  }

  osWriteGuardStatus(): OsWriteGuardStatus {
    // Only the platform whose spawn wrapper actually applies the guard may claim it: the guard is a
    // no-op off darwin (see `protectManagedRuntimeWrites`), so a present-looking component
    // elsewhere must not raise the level.
    const componentPresent = this.componentPresent(OS_WRITE_GUARD_COMPONENT)
    return {
      platform: this.platform,
      component: OS_WRITE_GUARD_COMPONENT,
      componentPresent,
      available: this.platform === 'darwin' && componentPresent
    }
  }

  async snapshot(
    surface: ExecutionSurface,
    remote?: RemoteExecutionTarget
  ): Promise<ExecutionProtectionSnapshot> {
    const egress = await this.readEgress()
    return resolveExecutionProtection({
      surface,
      platform: this.platform,
      networkAllowlistEnabled: egress?.enabled === true,
      osWriteGuardAvailable: this.osWriteGuardStatus().available,
      ...(remote ? { remote } : {}),
      capturedAt: this.now()
    })
  }

  async matrix(): Promise<ExecutionProtectionMatrix> {
    const egress = await this.readEgress()
    const policy = (await this.readPolicy?.()) ?? DEFAULT_REMOTE_UNPROTECTED_EXECUTION_POLICY
    const capturedAt = this.now()
    const osWriteGuard = this.osWriteGuardStatus()
    return {
      platform: this.platform,
      capturedAt,
      osWriteGuard,
      networkAllowlist: { enabled: egress?.enabled === true },
      surfaces: SURFACES.map((surface) =>
        resolveExecutionProtection({
          surface,
          platform: this.platform,
          networkAllowlistEnabled: egress?.enabled === true,
          osWriteGuardAvailable: osWriteGuard.available,
          capturedAt
        })
      ),
      remoteUnprotectedPolicy: policy
    }
  }

  async remoteUnprotectedPolicy(): Promise<RemoteUnprotectedExecutionPolicy> {
    return (await this.readPolicy?.()) ?? DEFAULT_REMOTE_UNPROTECTED_EXECUTION_POLICY
  }
}

export const createExecutionProtectionService = (
  deps: ExecutionProtectionServiceDeps
): ExecutionProtectionService => new ExecutionProtectionService(deps)

/**
 * A resolver for constructions that were not handed the live protection service (isolated embedders
 * and tests). It reports only what is knowable without reading settings — the local OS write-guard —
 * and treats the network axis as unfiltered instead of assuming the allowlist is on.
 *
 * Understating is the deliberate direction: a missing wire must never make a run look protected, and
 * the authoritative answer for a user is always the matrix query, which does read settings live.
 */
export const conservativeExecutionProtectionResolver =
  (
    platform: NodeJS.Platform,
    componentPresent: (path: string) => boolean = existsSync
  ): ((surface: ExecutionSurface) => Promise<ExecutionProtectionSnapshot>) =>
  (surface: ExecutionSurface): Promise<ExecutionProtectionSnapshot> =>
    Promise.resolve(
      resolveExecutionProtection({
        surface,
        platform,
        networkAllowlistEnabled: false,
        osWriteGuardAvailable: platform === 'darwin' && componentPresent(OS_WRITE_GUARD_COMPONENT)
      })
    )

export { ExecutionProtectionService }
