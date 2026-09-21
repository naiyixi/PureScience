import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { ArtifactFile } from '../../shared/artifacts'
import type { ArtifactRpcCapabilityBinding } from '../../shared/artifact-provenance'
import { getNotebookDataRoot, getNotebookSessionRoot } from '../notebook/repository'
import type { ArtifactRunContext } from '../artifacts/mcp-server'
import { ArtifactRepository, getArtifactCurrentRunFilePath } from '../artifacts/repository'
import { ArtifactRunRegistry } from '../artifacts/run-registry'
import { ARTIFACT_RPC_METHODS } from '../artifacts/rpc-methods'

const artifactTurnHandleKey = Symbol('artifact-turn-handle')

type ArtifactTurnHandle = {
  readonly [artifactTurnHandleKey]: symbol
}

type ArtifactTurnProvenanceContext = {
  rootFrameId?: string
  agentFrameId?: string
  messageBranchId?: string
  messageBranchAncestry?: string[]
  messageAncestry?: string[]
  runtimeSegmentId?: string
  promptMessageId?: string
}

type OpenArtifactTurnRequest = {
  appSessionId: string
  artifactStorageSessionId: string
  projectId: string
  agentName: string
  provenanceContext?: ArtifactTurnProvenanceContext
}

type ArtifactTurnWriteInput = {
  filename: string
  content: string
  mimeType?: string
  kind?: 'plan'
}

type ArtifactTurnPublication = {
  appSessionId: string
  artifactStorageSessionId: string
  runId: string
  promptMessageId: string
  artifactClaimId: string
  artifacts: ArtifactFile[]
}

type ArtifactTurnSnapshot = {
  appSessionId: string
  runId: string
  phase: 'open' | 'sealing' | 'finalized' | 'disposed'
  outstandingWrites: number
  terminalResult?: { kind: 'empty' } | { kind: 'publication'; artifactCount: number }
}

type ArtifactTurnProvenance = {
  listRunVersions: (request: {
    projectId: string
    appSessionId: string
    artifactRunId: string
  }) => Promise<ArtifactFile[]>
  writeAppGeneratedVersion: (request: {
    projectId: string
    appSessionId: string
    artifactStorageSessionId: string
    artifactRunId: string
    rootFrameId: string
    agentFrameId: string
    messageBranchId: string
    messageBranchAncestry: string[]
    messageAncestry: string[]
    runtimeSegmentId: string
    promptMessageId: string
    agentName: string
    filename: string
    content: string
    contentType?: string
    kind?: 'plan'
  }) => Promise<ArtifactFile>
}

type ArtifactTurnOwnerOptions = {
  dataRoot: string
  repository: ArtifactRepository
  runRegistry: ArtifactRunRegistry
  now?: () => number
  issueRpcCapability?: (binding: ArtifactRpcCapabilityBinding) => string
  revokeRpcCapability?: (token: string) => Promise<void> | void
  /** Retires one turn's authority inside a session capability when that turn seals. */
  retireRpcCapabilityScope?: (token: string, artifactRunId: string) => Promise<void> | void
  /** Adds a turn to an existing capability instead of issuing one per turn. */
  extendRpcCapability?: (
    token: string,
    scope: Pick<
      ArtifactRpcCapabilityBinding,
      | 'artifactRunId'
      | 'rootFrameId'
      | 'agentFrameId'
      | 'runtimeSegmentId'
      | 'promptMessageId'
      | 'messageBranchId'
    >
  ) => boolean
  provenance?: ArtifactTurnProvenance
  writeHandoffFile?: (filePath: string, content: string) => Promise<void>
  notebook?: {
    setArtifactProvenanceContext?: (
      sessionId: string,
      context:
        | {
            rootFrameId: string
            agentFrameId: string
            messageBranchId: string
            runtimeSegmentId: string
            promptMessageId: string
          }
        | undefined
    ) => void
  }
}

type ArtifactTurn = {
  appSessionId: string
  artifactStorageSessionId: string
  projectId: string
  runId: string
  currentRunFile: string
  rootFrameId: string
  agentFrameId: string
  messageBranchId: string
  messageBranchAncestry: string[]
  messageAncestry: string[]
  runtimeSegmentId: string
  promptMessageId: string
  agentName: string
  rpcCapabilityToken?: string
  phase: 'open' | 'sealing' | 'finalized' | 'disposed'
  inFlightAppWrites: Set<Promise<ArtifactFile>>
  writeDrainPromise?: Promise<void>
  finalizationPromise?: Promise<ArtifactTurnPublication | undefined>
  disposalPromise?: Promise<void>
  terminalResult?: { kind: 'empty' } | { kind: 'publication'; artifactCount: number }
}

class ArtifactTurnOwner {
  private readonly activeTurnsBySession = new Map<string, ArtifactTurn>()
  // One capability per artifact storage session. A per-turn capability is spent the moment its turn ends,
  // and the artifact server keeps whatever it was started with — which is how every write in a later turn
  // ends up holding a dead token. The session's capability is extended with each turn's identities instead,
  // and only revoked when the session has no active turn left.
  private readonly rpcCapabilitiesBySession = new Map<
    string,
    { appSessionId: string; token: string }
  >()
  private readonly sessionHandoffQueues = new Map<string, Promise<void>>()
  // Seal drains that are still running. The session capability must not be released while one of them is
  // outstanding: this turn's writes were admitted before the seal, and taking the credential away now would
  // lose the versions they are still landing.
  private readonly sealDrains = new Set<Promise<void>>()
  private readonly turnsByHandle = new WeakMap<ArtifactTurnHandle, ArtifactTurn>()
  private readonly now: () => number
  private sequence = 0

  constructor(private readonly options: ArtifactTurnOwnerOptions) {
    this.now = options.now ?? Date.now
  }

  async open(request: OpenArtifactTurnRequest): Promise<ArtifactTurnHandle> {
    const turn = this.createTurn(request)
    const runContext = this.createRunContext(turn)
    return this.withSessionHandoffLock(turn.appSessionId, async () => {
      let handoffWritten = false

      const existing = this.rpcCapabilitiesBySession.get(turn.artifactStorageSessionId)
      const existingToken = existing?.token
      if (
        existingToken &&
        this.options.extendRpcCapability?.(existingToken, {
          artifactRunId: turn.runId,
          rootFrameId: turn.rootFrameId,
          agentFrameId: turn.agentFrameId,
          runtimeSegmentId: turn.runtimeSegmentId,
          promptMessageId: turn.promptMessageId,
          messageBranchId: turn.messageBranchId
        })
      ) {
        turn.rpcCapabilityToken = existingToken
      }
      turn.rpcCapabilityToken ??= this.options.issueRpcCapability?.({
        projectId: turn.projectId,
        appSessionId: turn.appSessionId,
        artifactStorageSessionId: turn.artifactStorageSessionId,
        artifactRunId: turn.runId,
        rootFrameId: turn.rootFrameId,
        agentFrameId: turn.agentFrameId,
        messageBranchId: turn.messageBranchId,
        messageBranchAncestry: turn.messageBranchAncestry,
        messageAncestry: turn.messageAncestry,
        runtimeSegmentId: turn.runtimeSegmentId,
        promptMessageId: turn.promptMessageId,
        agentName: turn.agentName,
        ...(this.options.notebook ? { notebookSessionId: turn.appSessionId } : {}),
        // No `allowedMethods` here on purpose: the capability inherits the canonical artifact method
        // set. A literal array at this site is how a newly added method ends up permanently denied
        // while every suite stays green (verified live 2026-09-13).
        allowedMethods: [...ARTIFACT_RPC_METHODS]
      })
      if (turn.rpcCapabilityToken) {
        const previous = this.rpcCapabilitiesBySession.get(turn.artifactStorageSessionId)
        if (previous && previous.token !== turn.rpcCapabilityToken) {
          // Replacing a capability without revoking it would leave a token that is still valid and no longer
          // reachable by the release path.
          void Promise.resolve()
            .then(() => this.options.revokeRpcCapability?.(previous.token))
            .catch(() => undefined)
        }
        this.rpcCapabilitiesBySession.set(turn.artifactStorageSessionId, {
          appSessionId: turn.appSessionId,
          token: turn.rpcCapabilityToken
        })
        runContext.rpcCapabilityToken = turn.rpcCapabilityToken
      }

      try {
        await mkdir(dirname(turn.currentRunFile), { recursive: true })
        await this.writeHandoffFile(turn.currentRunFile, runContext)
        handoffWritten = true
        this.options.notebook?.setArtifactProvenanceContext?.(turn.appSessionId, {
          rootFrameId: turn.rootFrameId,
          agentFrameId: turn.agentFrameId,
          messageBranchId: turn.messageBranchId,
          runtimeSegmentId: turn.runtimeSegmentId,
          promptMessageId: turn.promptMessageId
        })
      } catch (error) {
        if (turn.rpcCapabilityToken) {
          try {
            // A failed open retires this turn's authority instead of revoking the session's capability: the
            // token belongs to the artifact storage session and may already serve another turn, so revoking it
            // here would take the credential away from turns that still need it. Retiring also waits for
            // whatever this turn had already had admitted before the failure.
            await this.options.retireRpcCapabilityScope?.(turn.rpcCapabilityToken, turn.runId)
          } catch {
            // Preserve the activation failure while still attempting every remaining cleanup stage.
          }
        }
        if (handoffWritten) {
          try {
            await this.writeHandoffFile(turn.currentRunFile, {})
          } catch {
            // The original activation failure remains the caller-visible error.
          }
          try {
            this.options.notebook?.setArtifactProvenanceContext?.(turn.appSessionId, undefined)
          } catch {
            // The original activation failure remains the caller-visible error.
          }
        }
        throw error
      }

      this.activeTurnsBySession.set(turn.appSessionId, turn)
      const handle: ArtifactTurnHandle = { [artifactTurnHandleKey]: Symbol(turn.runId) }
      this.turnsByHandle.set(handle, turn)
      return handle
    })
  }

  activeRunIds(): string[] {
    return Array.from(this.activeTurnsBySession.values(), (turn) => turn.runId)
  }

  promptMessageIdFor(sessionId: string): string | undefined {
    return this.activeTurnsBySession.get(sessionId)?.promptMessageId
  }

  snapshot(handle: ArtifactTurnHandle): ArtifactTurnSnapshot {
    const turn = this.resolve(handle)
    return {
      appSessionId: turn.appSessionId,
      runId: turn.runId,
      phase: turn.phase,
      outstandingWrites: turn.inFlightAppWrites.size,
      ...(turn.terminalResult ? { terminalResult: turn.terminalResult } : {})
    }
  }

  writeForActiveTurn(sessionId: string, input: ArtifactTurnWriteInput): Promise<ArtifactFile> {
    const turn = sessionId ? this.activeTurnsBySession.get(sessionId) : undefined
    if (!turn || turn.phase !== 'open') {
      return Promise.reject(new Error('No active assistant turn to attach a generated file to.'))
    }

    const write = this.options.provenance
      ? this.options.provenance.writeAppGeneratedVersion({
          projectId: turn.projectId,
          appSessionId: turn.appSessionId,
          artifactStorageSessionId: turn.artifactStorageSessionId,
          artifactRunId: turn.runId,
          rootFrameId: turn.rootFrameId,
          agentFrameId: turn.agentFrameId,
          messageBranchId: turn.messageBranchId,
          messageBranchAncestry: turn.messageBranchAncestry,
          messageAncestry: turn.messageAncestry,
          runtimeSegmentId: turn.runtimeSegmentId,
          promptMessageId: turn.promptMessageId,
          agentName: turn.agentName,
          filename: input.filename,
          content: input.content,
          contentType: input.mimeType,
          kind: input.kind
        })
      : this.options.repository.writePendingFile({
          projectName: turn.projectId,
          sessionId: turn.artifactStorageSessionId,
          runId: turn.runId,
          filename: input.filename,
          mimeType: input.mimeType,
          kind: input.kind,
          source: { kind: 'inline', content: input.content, encoding: 'utf8' }
        })

    turn.inFlightAppWrites.add(write)
    void write.then(
      () => turn.inFlightAppWrites.delete(write),
      () => turn.inFlightAppWrites.delete(write)
    )
    return write
  }

  finalize(handle: ArtifactTurnHandle): Promise<ArtifactTurnPublication | undefined> {
    const turn = this.resolve(handle)
    if (turn.disposalPromise && !turn.finalizationPromise) {
      return Promise.reject(new Error('Artifact turn is already disposing or disposed.'))
    }
    if (!turn.finalizationPromise) {
      const finalization = this.finalizeTurn(turn)
      turn.finalizationPromise = finalization
      void finalization.catch(() => {
        // Claim preparation can fail transiently. Preserve the runtime's existing finally retry while
        // keeping a concurrent disposal terminal and non-reopenable.
        if (turn.finalizationPromise === finalization && !turn.disposalPromise) {
          turn.finalizationPromise = undefined
        }
      })
    }
    return turn.finalizationPromise
  }

  dispose(handle: ArtifactTurnHandle): Promise<void> {
    const turn = this.resolve(handle)
    turn.disposalPromise ??= this.disposeAfterFinalization(turn)
    return turn.disposalPromise
  }

  private createTurn(request: OpenArtifactTurnRequest): ArtifactTurn {
    this.sequence += 1
    const runId = `artifact-run-${this.now()}-${this.sequence}`
    const rootFrameId =
      request.provenanceContext?.rootFrameId ?? `root-frame-${request.appSessionId}`
    const messageBranchId =
      request.provenanceContext?.messageBranchId ?? `message-branch-${request.appSessionId}`
    const promptMessageId = request.provenanceContext?.promptMessageId ?? `prompt-${runId}`
    const messageBranchAncestry = [
      ...(request.provenanceContext?.messageBranchAncestry ?? []).filter(
        (branchId) => branchId !== messageBranchId
      ),
      messageBranchId
    ]
    const messageAncestry = [
      ...(request.provenanceContext?.messageAncestry ?? []).filter(
        (messageId) => messageId !== promptMessageId
      ),
      promptMessageId
    ]

    return {
      appSessionId: request.appSessionId,
      artifactStorageSessionId: request.artifactStorageSessionId,
      projectId: request.projectId,
      runId,
      currentRunFile: getArtifactCurrentRunFilePath(
        this.options.dataRoot,
        request.projectId,
        request.artifactStorageSessionId
      ),
      rootFrameId,
      agentFrameId: request.provenanceContext?.agentFrameId ?? rootFrameId,
      messageBranchId,
      messageBranchAncestry,
      messageAncestry,
      // A headless turn has no renderer to supply a context, so the fallback has to agree with what the
      // Session writer will persist: a Session without a graph materializes into the linear projection,
      // whose Segment id is derived from the Session id. Naming the runtime instance here instead made
      // the claim and the durable graph disagree forever, so finalization could never succeed.
      runtimeSegmentId:
        request.provenanceContext?.runtimeSegmentId ?? `runtime-segment-${request.appSessionId}`,
      promptMessageId,
      agentName: request.agentName,
      phase: 'open',
      inFlightAppWrites: new Set()
    }
  }

  private createRunContext(turn: ArtifactTurn): ArtifactRunContext {
    const base = {
      artifactRunId: turn.runId,
      appSessionId: turn.appSessionId,
      rootFrameId: turn.rootFrameId,
      agentFrameId: turn.agentFrameId,
      messageBranchId: turn.messageBranchId,
      messageBranchAncestry: turn.messageBranchAncestry,
      messageAncestry: turn.messageAncestry,
      runtimeSegmentId: turn.runtimeSegmentId,
      promptMessageId: turn.promptMessageId,
      agentName: turn.agentName
    }
    return this.options.notebook
      ? {
          ...base,
          notebookSessionId: turn.appSessionId,
          notebookDataDir: getNotebookDataRoot(
            this.options.dataRoot,
            turn.projectId,
            turn.appSessionId
          ),
          notebookSessionRoot: getNotebookSessionRoot(
            this.options.dataRoot,
            turn.projectId,
            turn.appSessionId
          )
        }
      : base
  }

  /**
   * Releases the session's capability once no turn of that session is active any more. A session capability
   * that outlived its session would be exactly the standing credential this design is meant to avoid.
   */
  private releaseSessionCapability(appSessionId: string): void {
    const pendingDrains = [...this.sealDrains]
    if (pendingDrains.length > 0) {
      // A turn that is still sealing has writes in flight, and its capability has to outlive them.
      void Promise.allSettled(pendingDrains).then(() => this.releaseSessionCapability(appSessionId))
      return
    }
    const stillActive = [...this.activeTurnsBySession.values()].some(
      (turn) => turn.appSessionId === appSessionId && turn.phase !== 'disposed'
    )
    if (stillActive) return
    for (const [storageSessionId, entry] of this.rpcCapabilitiesBySession) {
      if (entry.appSessionId !== appSessionId) continue
      this.rpcCapabilitiesBySession.delete(storageSessionId)
      // The capability is out of the map either way, so a revocation that fails must not become an unhandled
      // rejection or a reason to keep standing authority alive.
      void Promise.resolve()
        .then(() => this.options.revokeRpcCapability?.(entry.token))
        .catch(() => undefined)
    }
  }

  private closeWrites(turn: ArtifactTurn): Promise<void> {
    if (turn.writeDrainPromise) return turn.writeDrainPromise

    turn.phase = 'sealing'
    // The capability belongs to the session now, so sealing one turn must not revoke it — but it must stop
    // authorizing that turn, or authority would outlive the turn it was granted for. The turn's scope is
    // retired instead; the capability itself is released when the session has no active turn left.
    // The call has to be *awaited*, not merely made: retiring a scope is what waits for the writes that were
    // admitted before the seal, and a fire-and-forget call would let the claim freeze while one of them is
    // still landing. The previous revision had a concise arrow body, which returned the promise; the braces
    // introduced here dropped it, and the version then arrived after finalization had already listed nothing.
    const rpcDrain = turn.rpcCapabilityToken
      ? Promise.resolve().then(() =>
          this.options.retireRpcCapabilityScope?.(turn.rpcCapabilityToken as string, turn.runId)
        )
      : Promise.resolve()
    turn.writeDrainPromise = (async () => {
      const [rpcResult] = await Promise.allSettled([
        rpcDrain,
        Promise.allSettled([...turn.inFlightAppWrites])
      ])
      if (rpcResult.status === 'rejected') throw rpcResult.reason
    })()
    const drain = turn.writeDrainPromise
    this.sealDrains.add(drain)
    // The cleanup chain swallows the drain's own failure on purpose: the seal reports it to the caller
    // through writeDrainPromise, and a rejection escaping from here would be an unhandled one — a failing
    // retirement would show up as a crash rather than as the turn's error.
    void drain
      .catch(() => undefined)
      .finally(() => {
        this.sealDrains.delete(drain)
        // Draining can be what makes the session empty, and a release attempted while it ran was deferred.
        this.releaseSessionCapability(turn.appSessionId)
      })
    return drain
  }

  private async finalizeTurn(turn: ArtifactTurn): Promise<ArtifactTurnPublication | undefined> {
    await this.closeWrites(turn)

    let artifacts: ArtifactFile[]
    let artifactVersionIds: string[] | undefined
    if (this.options.provenance) {
      artifacts = await this.options.provenance.listRunVersions({
        projectId: turn.projectId,
        appSessionId: turn.appSessionId,
        artifactRunId: turn.runId
      })
      artifactVersionIds = artifacts
        .map((artifact) => artifact.versionId)
        .filter(Boolean) as string[]
    } else {
      artifacts = await this.options.repository.listPendingRunFiles({
        projectName: turn.projectId,
        sessionId: turn.artifactStorageSessionId,
        runId: turn.runId
      })
    }

    if (artifacts.length === 0) {
      turn.phase = 'finalized'
      turn.terminalResult = { kind: 'empty' }
      return undefined
    }

    await this.options.repository.prepareRunFinalization({
      projectName: turn.projectId,
      sourceSessionId: turn.artifactStorageSessionId,
      sessionId: turn.appSessionId,
      runId: turn.runId,
      ...(artifactVersionIds ? { artifactVersionIds } : {}),
      provenanceContext: {
        rootFrameId: turn.rootFrameId,
        agentFrameId: turn.agentFrameId,
        messageBranchId: turn.messageBranchId,
        runtimeSegmentId: turn.runtimeSegmentId,
        promptMessageId: turn.promptMessageId
      }
    })

    const artifactClaimId = this.options.runRegistry.register({
      projectName: turn.projectId,
      artifactSessionId: turn.artifactStorageSessionId,
      sessionId: turn.appSessionId,
      runId: turn.runId,
      artifactVersionIds,
      rootFrameId: turn.rootFrameId,
      agentFrameId: turn.agentFrameId,
      messageBranchId: turn.messageBranchId,
      messageBranchAncestry: turn.messageBranchAncestry,
      messageAncestry: turn.messageAncestry,
      runtimeSegmentId: turn.runtimeSegmentId,
      promptMessageId: turn.promptMessageId
    })
    const publication = {
      appSessionId: turn.appSessionId,
      artifactStorageSessionId: turn.artifactStorageSessionId,
      runId: turn.runId,
      promptMessageId: turn.promptMessageId,
      artifactClaimId,
      artifacts
    }
    turn.phase = 'finalized'
    turn.terminalResult = { kind: 'publication', artifactCount: artifacts.length }
    return publication
  }

  private async disposeAfterFinalization(turn: ArtifactTurn): Promise<void> {
    if (turn.finalizationPromise) {
      try {
        await turn.finalizationPromise
      } catch {
        // Disposal must still clear every ephemeral resource after failed claim preparation.
      }
    }
    await this.disposeTurn(turn)
  }

  private async disposeTurn(turn: ArtifactTurn): Promise<void> {
    const cleanupErrors: unknown[] = []
    try {
      await this.closeWrites(turn)
    } catch (error) {
      cleanupErrors.push(error)
    }

    await this.withSessionHandoffLock(turn.appSessionId, async () => {
      const activeTurn = this.activeTurnsBySession.get(turn.appSessionId)
      const ownsActiveTurn = activeTurn === turn
      const ownsDistinctHandoff = activeTurn?.currentRunFile !== turn.currentRunFile
      try {
        if (ownsActiveTurn || ownsDistinctHandoff) {
          await this.writeHandoffFile(turn.currentRunFile, {})
        }
      } catch (error) {
        cleanupErrors.push(error)
      }
      try {
        if (ownsActiveTurn) {
          this.options.notebook?.setArtifactProvenanceContext?.(turn.appSessionId, undefined)
        }
      } catch (error) {
        cleanupErrors.push(error)
      } finally {
        if (this.activeTurnsBySession.get(turn.appSessionId) === turn) {
          this.activeTurnsBySession.delete(turn.appSessionId)
        }
        turn.phase = 'disposed'
        this.releaseSessionCapability(turn.appSessionId)
      }
    })
    if (cleanupErrors.length > 0) throw cleanupErrors[0]
  }

  private writeHandoffFile(filePath: string, value: ArtifactRunContext | object): Promise<void> {
    const content = `${JSON.stringify(value)}\n`
    return this.options.writeHandoffFile
      ? this.options.writeHandoffFile(filePath, content)
      : writeFile(filePath, content, 'utf8')
  }

  private withSessionHandoffLock<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.sessionHandoffQueues.get(sessionId) ?? Promise.resolve()
    const current = previous.then(operation)
    const tail = current.then(
      () => undefined,
      () => undefined
    )
    this.sessionHandoffQueues.set(sessionId, tail)
    void tail.then(() => {
      if (this.sessionHandoffQueues.get(sessionId) === tail) {
        this.sessionHandoffQueues.delete(sessionId)
      }
    })
    return current
  }

  private resolve(handle: ArtifactTurnHandle): ArtifactTurn {
    const turn = this.turnsByHandle.get(handle)
    if (!turn) throw new Error('Unknown Artifact turn handle')
    return turn
  }
}

export { ArtifactTurnOwner }
export type {
  ArtifactTurnHandle,
  ArtifactTurnOwnerOptions,
  ArtifactTurnPublication,
  ArtifactTurnSnapshot,
  ArtifactTurnWriteInput,
  OpenArtifactTurnRequest
}
