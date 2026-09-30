import type { ComputeApprovalRequest, ComputeApprovalDecision } from '../../shared/compute'
import {
  DEFAULT_REMOTE_UNPROTECTED_EXECUTION_POLICY,
  policyDeniesUnprotectedExecution,
  rememberedApprovalCoversUnprotected,
  type RemoteUnprotectedExecutionPolicy
} from '../../shared/execution-protection'
import type { ComputePermissionGrantAdapter } from './permission-grant-adapter'

import { createLogger } from '../logger'

// Re-export so callers that import from this module don't have to reference shared/compute directly.
export type { ComputeApprovalDecision }

const log = createLogger('compute-approval')

// Context passed with each approval request so the broker can check and record grants.
export type ComputeApprovalContext = {
  // Stable logical Session identifier. The durable adapter persists it across process restarts;
  // the legacy fallback below keeps the former in-memory behavior for isolated callers and tests.
  sessionId: string
  // Project identifier used for project-scope persistent grants.
  projectId: string
  // The compute operation being approved (e.g. 'call_command').
  operation: string
  // Immutable ComputeHost row id captured with the request. Provider ids are reusable, so this
  // distinguishes a deleted host from a later host created with the same SSH alias.
  ownerId?: string
}

type ComputeApprovalBrokerDeps = {
  // Pushes a pending approval request to the renderer.
  broadcast: (request: ComputeApprovalRequest, context?: ComputeApprovalContext) => void
  // Injectable for deterministic tests; defaults to crypto.randomUUID.
  generateId: () => string
  // How long to wait before auto-denying (default: 5 minutes).
  timeoutMs?: number
  // Injectable timer for tests.
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void
  permissionGrants?: ComputePermissionGrantAdapter
  // Optional: check whether a project-scope grant exists for (projectId, operation, providerId).
  // Return true → skip the approval card with 'project' decision.
  checkProjectGrant?: (grant: {
    projectId: string
    operation: string
    providerId: string
  }) => Promise<boolean>
  // Optional: persist a new project-scope grant.
  saveProjectGrant?: (grant: {
    projectId: string
    operation: string
    providerId: string
  }) => Promise<void>
  // Revalidates the immutable host identity immediately before a remembered decision is persisted.
  isProviderCurrent?: (owner: { providerId: string; ownerId?: string }) => Promise<boolean>
  // How remote execution with no protection is treated. Absent means the default policy: ask
  // explicitly every time, never let a remembered approval cover it silently.
  readRemoteUnprotectedPolicy?: () =>
    | RemoteUnprotectedExecutionPolicy
    | Promise<RemoteUnprotectedExecutionPolicy | undefined>
    | undefined
}

// Bridges the main-process compute gate to the renderer approval card. Holds the call_command
// open (a Promise) while the user decides; auto-denies after timeoutMs to prevent indefinite hangs.
// Follows the same promise + broadcast + IPC-respond pattern as ApprovalBroker in connectors.
//
// The wire protocol retains `conversation`, but the production adapter translates it to a durable
// Session grant. Project and Global use the same Registry; settings.json is read only for lazy legacy
// Project migration. Callers without the adapter retain the older in-memory/test hooks below.
//
// Use request() for legacy callers that do not supply context (only 'once'/'deny' can result).
// Use requestWithContext() to enable grant memory.
export class ComputeApprovalBroker {
  private readonly pending = new Map<
    string,
    {
      resolve: (decision: ComputeApprovalDecision) => void
      timer: ReturnType<typeof setTimeout>
      providerId: string
    }
  >()

  private readonly providerGenerations = new Map<string, number>()
  private readonly invalidatingProviders = new Set<string>()
  private readonly inFlightRequests = new Map<string, Set<Promise<ComputeApprovalDecision>>>()

  // Legacy fallback used only when no durable adapter is supplied.
  private readonly conversationGrants = new Set<string>()

  private readonly timeoutMs: number
  private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  private readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void

  constructor(private readonly deps: ComputeApprovalBrokerDeps) {
    this.timeoutMs = deps.timeoutMs ?? 5 * 60_000
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h))
  }

  // Broadcasts an approval request and resolves once the renderer responds (or the timeout denies).
  // Does NOT check grants — use requestWithContext for that.
  request(
    info: Omit<ComputeApprovalRequest, 'id'>,
    context?: ComputeApprovalContext
  ): Promise<ComputeApprovalDecision> {
    const id = this.deps.generateId()
    const providerId = info.provider_id

    return new Promise<ComputeApprovalDecision>((resolve) => {
      const timer = this.setTimer(() => this.settle(id, 'deny'), this.timeoutMs)
      this.pending.set(id, { resolve, timer, providerId })
      this.deps.broadcast({ id, ...info }, context)
    })
  }

  // Like request(), but checks conversation and project grants first. If a grant matches, resolves
  // immediately without broadcasting. When the user responds with a scope that has memory, records it.
  requestWithContext(
    info: Omit<ComputeApprovalRequest, 'id'>,
    ctx: ComputeApprovalContext
  ): Promise<ComputeApprovalDecision> {
    const providerId = info.provider_id
    if (this.invalidatingProviders.has(providerId)) return Promise.resolve('deny')

    const request = this.requestWithContextOperation(info, ctx)
    const requests = this.inFlightRequests.get(providerId) ?? new Set()
    requests.add(request)
    this.inFlightRequests.set(providerId, requests)
    void request.then(
      () => this.releaseInFlightRequest(providerId, request),
      () => this.releaseInFlightRequest(providerId, request)
    )
    return request
  }

  private async requestWithContextOperation(
    info: Omit<ComputeApprovalRequest, 'id'>,
    ctx: ComputeApprovalContext
  ): Promise<ComputeApprovalDecision> {
    const { sessionId, projectId, operation } = ctx
    const providerId = info.provider_id
    const providerGeneration = this.providerGenerations.get(providerId) ?? 0

    // ── unprotected remote execution policy ────────────────────────────────────────
    // A remote run cannot be isolated by this machine, so the level it would run at is decided before
    // any grant is consulted. Under `deny` there is no card: the run is refused outright. Under the
    // default (`confirm`), a remembered approval is not allowed to cover it — that approval was
    // granted without ever naming a protection level, so honoring it silently would be exactly the
    // silent unprotected execution this feature exists to remove.
    //
    // The policy is read ONLY for a request that carries a protection snapshot: a request without one
    // did not participate in protection reporting, and introducing an await on that path would change
    // the resolution order for every existing caller (a caller that answers synchronously after the
    // first flush would answer before the card is armed, and the request would hang).
    const isUnprotected = info.protection?.level === 'unprotected'
    let policy: RemoteUnprotectedExecutionPolicy = DEFAULT_REMOTE_UNPROTECTED_EXECUTION_POLICY
    let rememberedCoversRequest = true
    if (isUnprotected) {
      policy = await this.unprotectedPolicy()
      if (policyDeniesUnprotectedExecution(policy, info.protection!.level)) return 'deny'
      rememberedCoversRequest = rememberedApprovalCoversUnprotected(policy)
    }

    if (rememberedCoversRequest && this.deps.permissionGrants) {
      const durableScope = await this.deps.permissionGrants.resolve({
        sessionId,
        projectId,
        operation,
        providerId
      })
      if (durableScope) {
        if (!(await this.isProviderCurrent(providerId, ctx.ownerId, providerGeneration))) {
          return 'deny'
        }
        if (durableScope === 'session') return 'conversation'
        return durableScope
      }
    }

    // ── legacy project grant check (persistent) ───────────────────────────────────
    if (rememberedCoversRequest && this.deps.checkProjectGrant) {
      const hasProject = await this.deps.checkProjectGrant({ projectId, operation, providerId })
      if (hasProject) {
        return (await this.isProviderCurrent(providerId, ctx.ownerId, providerGeneration))
          ? 'project'
          : 'deny'
      }
    }

    // ── conversation grant check (session in-memory) ───────────────────────────────
    const convKey = `${sessionId}:${operation}:${providerId}`
    if (rememberedCoversRequest && this.conversationGrants.has(convKey)) {
      return (await this.isProviderCurrent(providerId, ctx.ownerId, providerGeneration))
        ? 'conversation'
        : 'deny'
    }

    // ── no grant — show approval card ─────────────────────────────────────────────
    // Grant lookups above are asynchronous. Invalidation may have started after this operation
    // entered the in-flight set but before it reached the approval card. Fail closed here so the
    // invalidator cannot miss a newly-created pending request and wait on it indefinitely.
    if (
      this.invalidatingProviders.has(providerId) ||
      (this.providerGenerations.get(providerId) ?? 0) !== providerGeneration
    ) {
      return 'deny'
    }
    const decision = await this.request(info, ctx)

    if ((this.providerGenerations.get(providerId) ?? 0) !== providerGeneration) return 'deny'

    const allowsDecision = decision !== 'deny'
    if (
      allowsDecision &&
      !(await this.isProviderCurrent(providerId, ctx.ownerId, providerGeneration))
    ) {
      return 'deny'
    }

    // Record grant if applicable. An unprotected request under a policy that does not honor
    // remembered approvals records nothing: persisting a grant the next call would ignore would make
    // the revocable-grant list lie about what the user has actually authorized. The refusal is named
    // rather than silent, so a caller that somehow offered that scope is visible in the log.
    if (!rememberedCoversRequest && decision !== 'deny' && decision !== 'once') {
      log.warn('unprotected remote approval scope was not memorized', {
        operation,
        providerId,
        scope: decision,
        policy
      })
    }

    if (rememberedCoversRequest && this.deps.permissionGrants) {
      await this.deps.permissionGrants.remember(
        { sessionId, projectId, operation, providerId },
        decision
      )
    } else if (rememberedCoversRequest && decision === 'conversation') {
      this.conversationGrants.add(convKey)
    } else if (rememberedCoversRequest && decision === 'project' && this.deps.saveProjectGrant) {
      await this.deps.saveProjectGrant({ projectId, operation, providerId })
    }

    if (
      allowsDecision &&
      !(await this.isProviderCurrent(providerId, ctx.ownerId, providerGeneration))
    ) {
      return 'deny'
    }

    return decision
  }

  // The stored policy, read fresh for every decision so a settings change applies to the next remote
  // operation instead of waiting for a restart. Absent reader or value means the default (ask).
  private async unprotectedPolicy(): Promise<RemoteUnprotectedExecutionPolicy> {
    const stored = await this.deps.readRemoteUnprotectedPolicy?.()
    return stored ?? DEFAULT_REMOTE_UNPROTECTED_EXECUTION_POLICY
  }

  // Called from the IPC handler when the renderer responds. Unknown ids are ignored.
  respond(id: string, decision: ComputeApprovalDecision): void {
    this.settle(id, decision)
  }

  // Host deletion begins by advancing its generation and denying every approval card that was
  // created for the old owner. A later host may reuse providerId, but it cannot reuse these calls.
  async invalidateProvider(providerId: string): Promise<void> {
    this.invalidatingProviders.add(providerId)
    this.providerGenerations.set(providerId, (this.providerGenerations.get(providerId) ?? 0) + 1)
    for (const key of this.conversationGrants) {
      if (key.endsWith(`:${providerId}`)) this.conversationGrants.delete(key)
    }
    for (const [id, entry] of this.pending) {
      if (entry.providerId === providerId) this.settle(id, 'deny')
    }
    await Promise.allSettled(Array.from(this.inFlightRequests.get(providerId) ?? []))
  }

  completeProviderInvalidation(providerId: string): void {
    this.invalidatingProviders.delete(providerId)
  }

  private releaseInFlightRequest(
    providerId: string,
    request: Promise<ComputeApprovalDecision>
  ): void {
    const requests = this.inFlightRequests.get(providerId)
    requests?.delete(request)
    if (requests?.size === 0) this.inFlightRequests.delete(providerId)
  }

  private async isProviderCurrent(
    providerId: string,
    ownerId: string | undefined,
    expectedGeneration: number
  ): Promise<boolean> {
    if ((this.providerGenerations.get(providerId) ?? 0) !== expectedGeneration) return false
    if (
      this.deps.isProviderCurrent &&
      !(await this.deps.isProviderCurrent({ providerId, ownerId }))
    ) {
      return false
    }
    return (this.providerGenerations.get(providerId) ?? 0) === expectedGeneration
  }

  private settle(id: string, decision: ComputeApprovalDecision): void {
    const entry = this.pending.get(id)
    if (!entry) return
    this.clearTimer(entry.timer)
    this.pending.delete(id)
    entry.resolve(decision)
  }
}
