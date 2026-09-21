import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ArtifactFile } from '../../shared/artifacts'
import { ArtifactRepository, getArtifactCurrentRunFilePath } from '../artifacts/repository'
import { ArtifactRunRegistry } from '../artifacts/run-registry'
import { createLinearConversationGraph } from '../../shared/conversation-graph'
import { ArtifactTurnOwner } from './artifact-turn-owner'
import type { ArtifactTurnHandle } from './artifact-turn-owner'
import { ARTIFACT_RPC_METHODS } from '../artifacts/rpc-methods'

const roots: string[] = []

const createRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'artifact-turn-owner-'))
  roots.push(root)
  return root
}

const createDeferred = <T = void>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
} => {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const artifactVersion = (overrides: Partial<ArtifactFile> = {}): ArtifactFile => ({
  id: 'version-1',
  name: 'result.txt',
  path: '/managed/result.txt',
  fileUrl: 'file:///managed/result.txt',
  mimeType: 'text/plain',
  size: 6,
  mtimeMs: 1,
  projectName: 'project-1',
  sessionId: 'artifact-session-1',
  runId: 'artifact-run-1',
  versionId: 'version-1',
  ...overrides
})

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('ArtifactTurnOwner', () => {
  it('names the durable linear Segment when no renderer supplies a context', async () => {
    const dataRoot = await createRoot()
    const notebookContexts: unknown[] = []
    const owner = new ArtifactTurnOwner({
      dataRoot,
      repository: new ArtifactRepository(dataRoot),
      runRegistry: new ArtifactRunRegistry(),
      now: () => 123,
      issueRpcCapability: () => 'secret-capability',
      notebook: {
        setArtifactProvenanceContext: (_sessionId, context) => notebookContexts.push(context)
      }
    })

    await owner.open({
      appSessionId: 'session-1',
      artifactStorageSessionId: 'artifact-session-1',
      projectId: 'project-1',
      agentName: 'Claude Code'
    })

    // Without a renderer there is no supplied context, and the Session a writer persists is the linear
    // projection. Deriving the Segment the same way is what keeps the claim's ownership provable.
    const linearSegmentId = createLinearConversationGraph({
      sessionId: 'session-1',
      messages: [],
      createdAt: 0,
      updatedAt: 0
    }).runtimeSegments[0].id
    expect(linearSegmentId).toBe('runtime-segment-session-1')
    expect(notebookContexts).toEqual([
      expect.objectContaining({ runtimeSegmentId: linearSegmentId })
    ])
  })

  it('opens a turn-scoped handoff without exposing its capability or local path in snapshots', async () => {
    const dataRoot = await createRoot()
    const issuedBindings: unknown[] = []
    const notebookContexts: unknown[] = []
    const owner = new ArtifactTurnOwner({
      dataRoot,
      repository: new ArtifactRepository(dataRoot),
      runRegistry: new ArtifactRunRegistry(),
      now: () => 123,
      issueRpcCapability: (binding) => {
        issuedBindings.push(binding)
        return 'secret-capability'
      },
      notebook: {
        setArtifactProvenanceContext: (_sessionId, context) => notebookContexts.push(context)
      }
    })

    const turn = await owner.open({
      appSessionId: 'session-1',
      artifactStorageSessionId: 'artifact-session-1',
      projectId: 'project-1',
      agentName: 'Claude Code',
      provenanceContext: {
        rootFrameId: 'root-1',
        agentFrameId: 'agent-1',
        messageBranchId: 'branch-1',
        messageBranchAncestry: ['branch-parent'],
        messageAncestry: ['message-parent', 'prompt-1'],
        runtimeSegmentId: 'segment-1',
        promptMessageId: 'prompt-1'
      }
    })

    expect(owner.activeRunIds()).toEqual(['artifact-run-123-1'])
    expect(owner.promptMessageIdFor('session-1')).toBe('prompt-1')
    expect(issuedBindings).toEqual([
      expect.objectContaining({
        projectId: 'project-1',
        appSessionId: 'session-1',
        artifactStorageSessionId: 'artifact-session-1',
        artifactRunId: 'artifact-run-123-1',
        notebookSessionId: 'session-1',
        allowedMethods: [...ARTIFACT_RPC_METHODS]
      })
    ])
    expect(notebookContexts).toEqual([
      {
        rootFrameId: 'root-1',
        agentFrameId: 'agent-1',
        messageBranchId: 'branch-1',
        runtimeSegmentId: 'segment-1',
        promptMessageId: 'prompt-1'
      }
    ])

    const currentRunFile = getArtifactCurrentRunFilePath(
      dataRoot,
      'project-1',
      'artifact-session-1'
    )
    const handoff = JSON.parse(await readFile(currentRunFile, 'utf8')) as Record<string, unknown>
    expect(handoff).toMatchObject({
      artifactRunId: 'artifact-run-123-1',
      rpcCapabilityToken: 'secret-capability',
      notebookSessionId: 'session-1',
      notebookDataDir: join(dataRoot, 'notebooks', 'project-1', 'session-1', 'data'),
      notebookSessionRoot: join(dataRoot, 'notebooks', 'project-1', 'session-1')
    })

    const snapshot = owner.snapshot(turn)
    expect(snapshot).toEqual({
      appSessionId: 'session-1',
      runId: 'artifact-run-123-1',
      phase: 'open',
      outstandingWrites: 0
    })
    expect(snapshot).not.toHaveProperty('rpcCapabilityToken')
    expect(snapshot).not.toHaveProperty('currentRunFile')
    expect(JSON.stringify(snapshot)).not.toContain('secret-capability')
    expect(JSON.stringify(snapshot)).not.toContain(dataRoot)
  })

  it('keeps app-side writes scoped to the active Session turn and fails closed otherwise', async () => {
    const dataRoot = await createRoot()
    const repository = new ArtifactRepository(dataRoot)
    const owner = new ArtifactTurnOwner({
      dataRoot,
      repository,
      runRegistry: new ArtifactRunRegistry(),
      now: () => 456
    })

    await owner.open({
      appSessionId: 'session-1',
      artifactStorageSessionId: 'artifact-session-1',
      projectId: 'project-1',
      agentName: 'Codex'
    })
    await owner.open({
      appSessionId: 'session-2',
      artifactStorageSessionId: 'artifact-session-2',
      projectId: 'project-1',
      agentName: 'Codex'
    })

    const first = await owner.writeForActiveTurn('session-1', {
      filename: 'first.txt',
      content: 'first'
    })
    const second = await owner.writeForActiveTurn('session-2', {
      filename: 'second.txt',
      content: 'second'
    })

    expect(first.sessionId).toBe('artifact-session-1')
    expect(second.sessionId).toBe('artifact-session-2')
    expect(first.runId).not.toBe(second.runId)
    await expect(
      owner.writeForActiveTurn('unknown-session', { filename: 'x.txt', content: 'x' })
    ).rejects.toThrow(/No active assistant turn/i)
  })

  it('seals synchronously, drains accepted app and RPC writes, and prepares one claim exactly once', async () => {
    const dataRoot = await createRoot()
    const repository = new ArtifactRepository(dataRoot)
    const releaseWrite = createDeferred()
    const releaseRpc = createDeferred()
    const writeStarted = createDeferred()
    const listedVersion = artifactVersion()
    const listRunVersions = vi.fn(async () => [listedVersion])
    const writeAppGeneratedVersion = vi.fn(async () => {
      writeStarted.resolve()
      await releaseWrite.promise
      return listedVersion
    })
    const prepareRunFinalization = vi.spyOn(repository, 'prepareRunFinalization')
    const runRegistry = new ArtifactRunRegistry()
    const register = vi.spyOn(runRegistry, 'register')
    const revokeRpcCapability = vi.fn(async () => releaseRpc.promise)
    const owner = new ArtifactTurnOwner({
      dataRoot,
      repository,
      runRegistry,
      provenance: { listRunVersions, writeAppGeneratedVersion },
      issueRpcCapability: () => 'capability-1',
      revokeRpcCapability,
      now: () => 789
    })
    const turn = await owner.open({
      appSessionId: 'session-1',
      artifactStorageSessionId: 'artifact-session-1',
      projectId: 'project-1',
      agentName: 'OpenCode'
    })
    const acceptedWrite = owner.writeForActiveTurn('session-1', {
      filename: 'result.txt',
      content: 'result'
    })
    await writeStarted.promise

    const firstFinalization = owner.finalize(turn)
    const repeatedFinalization = owner.finalize(turn)
    expect(firstFinalization).toBe(repeatedFinalization)
    await expect(
      owner.writeForActiveTurn('session-1', { filename: 'late.txt', content: 'late' })
    ).rejects.toThrow(/No active assistant turn/i)
    expect(listRunVersions).not.toHaveBeenCalled()

    releaseRpc.resolve()
    await Promise.resolve()
    expect(listRunVersions).not.toHaveBeenCalled()
    releaseWrite.resolve()
    await acceptedWrite

    const publication = await firstFinalization
    expect(publication).toMatchObject({
      appSessionId: 'session-1',
      artifactStorageSessionId: 'artifact-session-1',
      runId: 'artifact-run-789-1',
      artifactClaimId: expect.stringMatching(/^artifact-claim-/),
      artifacts: [listedVersion]
    })
    // Sealing one turn no longer revokes the capability: it belongs to the artifact storage session and the
    // next turn still needs it. It is released once that session has no active turn left.
    expect(revokeRpcCapability).not.toHaveBeenCalled()
    expect(listRunVersions).toHaveBeenCalledOnce()
    expect(prepareRunFinalization).toHaveBeenCalledOnce()
    expect(register).toHaveBeenCalledOnce()
    await expect(owner.finalize(turn)).resolves.toBe(publication)
  })

  it('keeps the seal waiting for the retirement it started, not merely starts it', async () => {
    const dataRoot = await createRoot()
    const repository = new ArtifactRepository(dataRoot)
    const releaseRetire = createDeferred()
    const retireStarted = createDeferred()
    const listedVersion = artifactVersion()
    const listRunVersions = vi.fn(async () => [listedVersion])
    const owner = new ArtifactTurnOwner({
      dataRoot,
      repository,
      runRegistry: new ArtifactRunRegistry(),
      provenance: {
        listRunVersions,
        writeAppGeneratedVersion: async () => listedVersion
      },
      issueRpcCapability: () => 'capability-1',
      // Retiring the turn's scope is the wait that keeps an already-admitted write ahead of the frozen claim.
      // Its promise has to be awaited by the seal rather than merely started: dropping it let the version land
      // after finalization had already listed nothing, and the run published no claim at all.
      retireRpcCapabilityScope: vi.fn(async () => {
        retireStarted.resolve()
        await releaseRetire.promise
      }),
      now: () => 1_100
    })
    const turn = await owner.open({
      appSessionId: 'session-1',
      artifactStorageSessionId: 'artifact-session-1',
      projectId: 'project-1',
      agentName: 'Claude Code'
    })

    const finalization = owner.finalize(turn)
    await retireStarted.promise
    // No app-side write is outstanding in this case, so the retirement is the only thing the seal is waiting
    // for. Give the pending chain more than a couple of microtasks to prove it is not listed early.
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(listRunVersions).not.toHaveBeenCalled()

    releaseRetire.resolve()
    await finalization
    expect(listRunVersions).toHaveBeenCalledOnce()
  })

  it('caches an empty terminal result without creating a claim', async () => {
    const dataRoot = await createRoot()
    const repository = new ArtifactRepository(dataRoot)
    const listPendingRunFiles = vi.spyOn(repository, 'listPendingRunFiles')
    const runRegistry = new ArtifactRunRegistry()
    const register = vi.spyOn(runRegistry, 'register')
    const owner = new ArtifactTurnOwner({
      dataRoot,
      repository,
      runRegistry,
      now: () => 900
    })
    const turn = await owner.open({
      appSessionId: 'session-1',
      artifactStorageSessionId: 'artifact-session-1',
      projectId: 'project-1',
      agentName: 'Claude Code'
    })

    await expect(owner.finalize(turn)).resolves.toBeUndefined()
    await expect(owner.finalize(turn)).resolves.toBeUndefined()
    expect(listPendingRunFiles).toHaveBeenCalledOnce()
    expect(register).not.toHaveBeenCalled()
    expect(owner.snapshot(turn)).toEqual({
      appSessionId: 'session-1',
      runId: 'artifact-run-900-1',
      phase: 'finalized',
      outstandingWrites: 0,
      terminalResult: { kind: 'empty' }
    })
  })

  it('does not let stale cleanup erase a replacement turn owned by the same Session', async () => {
    const dataRoot = await createRoot()
    const notebookContexts: Array<{ sessionId: string; context: unknown }> = []
    const revoked: string[] = []
    let capabilitySequence = 0
    let now = 1_000
    const owner = new ArtifactTurnOwner({
      dataRoot,
      repository: new ArtifactRepository(dataRoot),
      runRegistry: new ArtifactRunRegistry(),
      now: () => now,
      issueRpcCapability: () => `capability-${++capabilitySequence}`,
      extendRpcCapability: () => true,
      revokeRpcCapability: (token) => {
        revoked.push(token)
      },
      notebook: {
        setArtifactProvenanceContext: (sessionId, context) => {
          notebookContexts.push({ sessionId, context })
        }
      }
    })
    const first = await owner.open({
      appSessionId: 'session-1',
      artifactStorageSessionId: 'session-1',
      projectId: 'project-1',
      agentName: 'Codex'
    })
    now = 1_001
    const replacement = await owner.open({
      appSessionId: 'session-1',
      artifactStorageSessionId: 'session-1',
      projectId: 'project-1',
      agentName: 'Codex'
    })

    await owner.dispose(first)
    const currentRunFile = getArtifactCurrentRunFilePath(dataRoot, 'project-1', 'session-1')
    await expect(readFile(currentRunFile, 'utf8')).resolves.toContain('artifact-run-1001-2')
    expect(owner.activeRunIds()).toEqual(['artifact-run-1001-2'])
    expect(notebookContexts.at(-1)?.context).not.toBeUndefined()

    await owner.dispose(replacement)
    await expect(readFile(currentRunFile, 'utf8')).resolves.toBe('{}\n')
    expect(owner.activeRunIds()).toEqual([])
    expect(notebookContexts.at(-1)).toEqual({ sessionId: 'session-1', context: undefined })
    // One capability for the session: the second turn extends the first turn's instead of taking a new one,
    // and the session's capability is what gets revoked when the session goes idle.
    expect(revoked).toEqual(['capability-1'])
  })

  it('serializes stale cleanup with a replacement opening the same handoff', async () => {
    const dataRoot = await createRoot()
    const cleanupWriteStarted = createDeferred()
    const releaseCleanupWrite = createDeferred()
    let writeCount = 0
    const owner = new ArtifactTurnOwner({
      dataRoot,
      repository: new ArtifactRepository(dataRoot),
      runRegistry: new ArtifactRunRegistry(),
      writeHandoffFile: async (filePath, content) => {
        writeCount += 1
        if (writeCount === 2) {
          cleanupWriteStarted.resolve()
          await releaseCleanupWrite.promise
        }
        await writeFile(filePath, content, 'utf8')
      }
    })
    const first = await owner.open({
      appSessionId: 'session-1',
      artifactStorageSessionId: 'session-1',
      projectId: 'project-1',
      agentName: 'Codex'
    })

    const staleDisposal = owner.dispose(first)
    await cleanupWriteStarted.promise
    const replacementOpening = owner.open({
      appSessionId: 'session-1',
      artifactStorageSessionId: 'session-1',
      projectId: 'project-1',
      agentName: 'Codex'
    })
    await Promise.resolve()
    expect(writeCount).toBe(2)

    releaseCleanupWrite.resolve()
    await staleDisposal
    const replacement = await replacementOpening
    const currentRunFile = getArtifactCurrentRunFilePath(dataRoot, 'project-1', 'session-1')
    await expect(readFile(currentRunFile, 'utf8')).resolves.toContain('artifact-run-')
    expect(owner.activeRunIds()).toHaveLength(1)
    await owner.dispose(replacement)
  })

  it('clears active ownership even when capability revocation fails', async () => {
    const dataRoot = await createRoot()
    const notebookContexts: unknown[] = []
    const writeStarted = createDeferred()
    const releaseWrite = createDeferred()
    const owner = new ArtifactTurnOwner({
      dataRoot,
      repository: new ArtifactRepository(dataRoot),
      runRegistry: new ArtifactRunRegistry(),
      provenance: {
        listRunVersions: async () => [],
        writeAppGeneratedVersion: async () => {
          writeStarted.resolve()
          await releaseWrite.promise
          return artifactVersion()
        }
      },
      issueRpcCapability: () => 'capability-1',
      revokeRpcCapability: async () => {
        throw new Error('revoke failed')
      },
      notebook: {
        setArtifactProvenanceContext: (_sessionId, context) => notebookContexts.push(context)
      }
    })
    const turn = await owner.open({
      appSessionId: 'session-1',
      artifactStorageSessionId: 'artifact-session-1',
      projectId: 'project-1',
      agentName: 'Codex'
    })
    const acceptedWrite = owner.writeForActiveTurn('session-1', {
      filename: 'accepted.txt',
      content: 'accepted'
    })
    await writeStarted.promise
    const currentRunFile = getArtifactCurrentRunFilePath(
      dataRoot,
      'project-1',
      'artifact-session-1'
    )

    const disposal = owner.dispose(turn)
    let disposalSettled = false
    void disposal.then(
      () => {
        disposalSettled = true
      },
      () => {
        disposalSettled = true
      }
    )
    await Promise.resolve()
    expect(disposalSettled).toBe(false)

    releaseWrite.resolve()
    await acceptedWrite
    // The session capability is revoked when the session goes idle, and a revocation that fails is contained:
    // the disposal still completes and ownership is still cleared, which is what this case is about.
    await expect(disposal).resolves.toBeUndefined()

    expect(disposalSettled).toBe(true)
    expect(owner.activeRunIds()).toEqual([])
    await expect(readFile(currentRunFile, 'utf8')).resolves.toBe('{}\n')
    expect(notebookContexts.at(-1)).toBeUndefined()
  })

  it('clears a stale turn handoff when its replacement uses a different storage Session', async () => {
    const dataRoot = await createRoot()
    const owner = new ArtifactTurnOwner({
      dataRoot,
      repository: new ArtifactRepository(dataRoot),
      runRegistry: new ArtifactRunRegistry()
    })
    const first = await owner.open({
      appSessionId: 'session-1',
      artifactStorageSessionId: 'artifact-session-provisional',
      projectId: 'project-1',
      agentName: 'Codex'
    })
    const replacement = await owner.open({
      appSessionId: 'session-1',
      artifactStorageSessionId: 'session-1',
      projectId: 'project-1',
      agentName: 'Codex'
    })
    const firstHandoff = getArtifactCurrentRunFilePath(
      dataRoot,
      'project-1',
      'artifact-session-provisional'
    )
    const replacementHandoff = getArtifactCurrentRunFilePath(dataRoot, 'project-1', 'session-1')

    await owner.dispose(first)

    await expect(readFile(firstHandoff, 'utf8')).resolves.toBe('{}\n')
    await expect(readFile(replacementHandoff, 'utf8')).resolves.toContain('artifact-run-')
    expect(owner.activeRunIds()).toHaveLength(1)
    await owner.dispose(replacement)
  })

  it('retries failed claim preparation without duplicating a successful claim', async () => {
    const dataRoot = await createRoot()
    const repository = new ArtifactRepository(dataRoot)
    const runRegistry = new ArtifactRunRegistry()
    const register = vi.spyOn(runRegistry, 'register')
    const listRunVersions = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary list failure'))
      .mockResolvedValue([artifactVersion()])
    const owner = new ArtifactTurnOwner({
      dataRoot,
      repository,
      runRegistry,
      provenance: {
        listRunVersions,
        writeAppGeneratedVersion: async () => artifactVersion()
      }
    })
    const turn = await owner.open({
      appSessionId: 'session-1',
      artifactStorageSessionId: 'artifact-session-1',
      projectId: 'project-1',
      agentName: 'Codex'
    })

    await expect(owner.finalize(turn)).rejects.toThrow('temporary list failure')
    await expect(owner.finalize(turn)).resolves.toMatchObject({
      artifactClaimId: expect.stringMatching(/^artifact-claim-/)
    })

    expect(listRunVersions).toHaveBeenCalledTimes(2)
    expect(register).toHaveBeenCalledOnce()
    await owner.dispose(turn)
  })

  it('serializes finalization with disposal and never reopens a disposed turn', async () => {
    const dataRoot = await createRoot()
    const listStarted = createDeferred()
    const releaseList = createDeferred()
    const owner = new ArtifactTurnOwner({
      dataRoot,
      repository: new ArtifactRepository(dataRoot),
      runRegistry: new ArtifactRunRegistry(),
      provenance: {
        listRunVersions: async () => {
          listStarted.resolve()
          await releaseList.promise
          return [artifactVersion()]
        },
        writeAppGeneratedVersion: async () => artifactVersion()
      }
    })
    const turn = await owner.open({
      appSessionId: 'session-1',
      artifactStorageSessionId: 'artifact-session-1',
      projectId: 'project-1',
      agentName: 'Codex'
    })
    const finalization = owner.finalize(turn)
    await listStarted.promise
    const disposal = owner.dispose(turn)
    let disposalSettled = false
    void disposal.then(() => {
      disposalSettled = true
    })

    await Promise.resolve()
    expect(disposalSettled).toBe(false)
    releaseList.resolve()
    const publication = await finalization
    await disposal

    expect(owner.snapshot(turn).phase).toBe('disposed')
    await expect(owner.finalize(turn)).resolves.toBe(publication)
    expect(owner.snapshot(turn).phase).toBe('disposed')

    const disposedWithoutFinalization = await owner.open({
      appSessionId: 'session-2',
      artifactStorageSessionId: 'artifact-session-2',
      projectId: 'project-1',
      agentName: 'Codex'
    })
    await owner.dispose(disposedWithoutFinalization)
    await expect(owner.finalize(disposedWithoutFinalization)).rejects.toThrow(/disposed/i)
  })

  it('clears a written handoff when Notebook provenance setup fails', async () => {
    const dataRoot = await createRoot()
    const contexts: unknown[] = []
    const revoked: string[] = []
    const retired: string[] = []
    const owner = new ArtifactTurnOwner({
      dataRoot,
      repository: new ArtifactRepository(dataRoot),
      runRegistry: new ArtifactRunRegistry(),
      issueRpcCapability: () => 'capability-1',
      // A failed open retires this turn's scope inside the session capability. The retirement is the callback
      // that has to be reached here, and it fails the same way revocation used to, so cleanup still has to
      // reach every remaining stage.
      retireRpcCapabilityScope: (_token, artifactRunId) => {
        retired.push(artifactRunId)
        throw new Error('cleanup retirement failed')
      },
      revokeRpcCapability: (token) => {
        revoked.push(token)
      },
      notebook: {
        setArtifactProvenanceContext: (_sessionId, context) => {
          contexts.push(context)
          if (context) throw new Error('Notebook context failed')
        }
      }
    })
    const currentRunFile = getArtifactCurrentRunFilePath(
      dataRoot,
      'project-1',
      'artifact-session-1'
    )

    await expect(
      owner.open({
        appSessionId: 'session-1',
        artifactStorageSessionId: 'artifact-session-1',
        projectId: 'project-1',
        agentName: 'Codex'
      })
    ).rejects.toThrow('Notebook context failed')

    await expect(readFile(currentRunFile, 'utf8')).resolves.toBe('{}\n')
    expect(contexts.at(-1)).toBeUndefined()
    // The session's capability is not revoked by a failed open any more: the turn's scope is retired instead,
    // and the retirement is reached even though it throws.
    expect(retired).toEqual([expect.stringMatching(/^artifact-run-/)])
    expect(revoked).toEqual([])
    expect(owner.activeRunIds()).toEqual([])
  })

  it('clears Notebook context and ownership when handoff cleanup fails', async () => {
    const dataRoot = await createRoot()
    const contexts: unknown[] = []
    const owner = new ArtifactTurnOwner({
      dataRoot,
      repository: new ArtifactRepository(dataRoot),
      runRegistry: new ArtifactRunRegistry(),
      notebook: {
        setArtifactProvenanceContext: (_sessionId, context) => contexts.push(context)
      }
    })
    const turn = await owner.open({
      appSessionId: 'session-1',
      artifactStorageSessionId: 'artifact-session-1',
      projectId: 'project-1',
      agentName: 'Codex'
    })
    const currentRunFile = getArtifactCurrentRunFilePath(
      dataRoot,
      'project-1',
      'artifact-session-1'
    )
    await rm(currentRunFile)
    await mkdir(currentRunFile)

    await expect(owner.dispose(turn)).rejects.toThrow()

    expect(contexts.at(-1)).toBeUndefined()
    expect(owner.activeRunIds()).toEqual([])
    expect(owner.snapshot(turn).phase).toBe('disposed')
  })

  it('retires the turn scope and publishes no active state when opening the handoff fails', async () => {
    const dataRoot = await createRoot()
    const blockedRoot = join(dataRoot, 'blocked')
    const repository = new ArtifactRepository(blockedRoot)
    const revoked: string[] = []
    const retired: string[] = []
    await repository.writePendingFile({
      projectName: 'seed',
      sessionId: 'seed',
      runId: 'seed',
      filename: 'seed.txt',
      source: { kind: 'inline', content: 'seed', encoding: 'utf8' }
    })
    // A file at the configured data root makes the current-run mkdir fail.
    const fileRoot = join(dataRoot, 'root-file')
    await writeFile(fileRoot, 'blocked')
    const failingOwner = new ArtifactTurnOwner({
      dataRoot: fileRoot,
      repository,
      runRegistry: new ArtifactRunRegistry(),
      issueRpcCapability: () => 'failed-open-capability',
      retireRpcCapabilityScope: (_token, artifactRunId) => {
        retired.push(artifactRunId)
      },
      revokeRpcCapability: (token) => {
        revoked.push(token)
      }
    })

    await expect(
      failingOwner.open({
        appSessionId: 'session-1',
        artifactStorageSessionId: 'artifact-session-1',
        projectId: 'project-1',
        agentName: 'Codex'
      })
    ).rejects.toThrow()
    expect(failingOwner.activeRunIds()).toEqual([])
    // The turn never opened, so nothing of it may stay authorized; the capability itself is the session's and
    // is not the failed open's to take away.
    expect(retired).toEqual([expect.stringMatching(/^artifact-run-/)])
    expect(revoked).toEqual([])
  })

  it('revokes the capability it replaces when the session has to be issued a new one', async () => {
    const dataRoot = await createRoot()
    const revoked: string[] = []
    let sequence = 0
    const owner = new ArtifactTurnOwner({
      dataRoot,
      repository: new ArtifactRepository(dataRoot),
      runRegistry: new ArtifactRunRegistry(),
      issueRpcCapability: () => `capability-${++sequence}`,
      // The stored capability cannot be extended, so this turn has to be issued its own. The one it replaces
      // stays valid until it is revoked, and nothing else holds a reference to it.
      extendRpcCapability: () => false,
      revokeRpcCapability: (token) => {
        revoked.push(token)
      },
      now: () => 1_200
    })

    await owner.open({
      appSessionId: 'session-1',
      artifactStorageSessionId: 'artifact-session-1',
      projectId: 'project-1',
      agentName: 'Claude Code'
    })
    // A replacement for the same artifact storage session — a fork or a restarted turn — takes a new
    // capability, and the one it displaces must not stay live and unreachable.
    await owner.open({
      appSessionId: 'session-2',
      artifactStorageSessionId: 'artifact-session-1',
      projectId: 'project-1',
      agentName: 'Claude Code'
    })

    await vi.waitFor(() => expect(revoked).toEqual(['capability-1']))
  })

  it('releases only the capability of the session that went idle', async () => {
    const dataRoot = await createRoot()
    const revoked: string[] = []
    let sequence = 0
    const owner = new ArtifactTurnOwner({
      dataRoot,
      repository: new ArtifactRepository(dataRoot),
      runRegistry: new ArtifactRunRegistry(),
      issueRpcCapability: () => `capability-${++sequence}`,
      revokeRpcCapability: (token) => {
        revoked.push(token)
      },
      now: () => 1_300
    })
    const first = await owner.open({
      appSessionId: 'session-1',
      artifactStorageSessionId: 'artifact-session-1',
      projectId: 'project-1',
      agentName: 'Claude Code'
    })
    const second = await owner.open({
      appSessionId: 'session-2',
      artifactStorageSessionId: 'artifact-session-2',
      projectId: 'project-1',
      agentName: 'Claude Code'
    })

    // The release walks the whole map, and a session going idle must not take another session's credential
    // with it — the two are only related by living in the same map.
    await owner.dispose(second)
    await vi.waitFor(() => expect(revoked).toEqual(['capability-2']))

    await owner.dispose(first)
    await vi.waitFor(() => expect(revoked).toEqual(['capability-2', 'capability-1']))
  })

  it('defers the release while another turn of the session is still sealing', async () => {
    const dataRoot = await createRoot()
    const repository = new ArtifactRepository(dataRoot)
    const retired: string[] = []
    const revoked: string[] = []
    const releaseRetire = createDeferred()
    const owner = new ArtifactTurnOwner({
      dataRoot,
      repository,
      runRegistry: new ArtifactRunRegistry(),
      issueRpcCapability: () => 'capability-1',
      extendRpcCapability: () => true,
      retireRpcCapabilityScope: async (_token, artifactRunId) => {
        retired.push(artifactRunId)
        await releaseRetire.promise
      },
      revokeRpcCapability: (token) => {
        revoked.push(token)
      },
      now: () => 1_400
    })
    const first = await owner.open({
      appSessionId: 'session-1',
      artifactStorageSessionId: 'artifact-session-1',
      projectId: 'project-1',
      agentName: 'Claude Code'
    })
    const second = await owner.open({
      appSessionId: 'session-1',
      artifactStorageSessionId: 'artifact-session-1',
      projectId: 'project-1',
      agentName: 'Claude Code'
    })

    const firstFinalization = owner.finalize(first)
    const secondFinalization = owner.finalize(second)
    await vi.waitFor(() => expect(retired).toHaveLength(2))

    // Both turns are sealing, so a release that ran when one of them settled would take the credential away
    // from the other's admitted writes.
    releaseRetire.resolve()
    await firstFinalization
    await secondFinalization
    expect(revoked).toEqual([])

    await owner.dispose(first)
    await owner.dispose(second)
    await vi.waitFor(() => expect(revoked).toEqual(['capability-1']))
  })

  it('surfaces a seal whose retirement rejects, and still clears ownership', async () => {
    const dataRoot = await createRoot()
    const owner = new ArtifactTurnOwner({
      dataRoot,
      repository: new ArtifactRepository(dataRoot),
      runRegistry: new ArtifactRunRegistry(),
      issueRpcCapability: () => 'capability-1',
      retireRpcCapabilityScope: () => {
        throw new Error('retirement failed')
      },
      now: () => 1_500
    })
    const turn = await owner.open({
      appSessionId: 'session-1',
      artifactStorageSessionId: 'artifact-session-1',
      projectId: 'project-1',
      agentName: 'Claude Code'
    })

    // A failed retirement is not a settled seal: the caller has to see it rather than get a claim frozen on
    // top of a wait that never happened.
    await expect(owner.finalize(turn)).rejects.toThrow('retirement failed')

    await expect(owner.dispose(turn)).rejects.toThrow('retirement failed')
    expect(owner.activeRunIds()).toEqual([])
    expect(owner.snapshot(turn).phase).toBe('disposed')
  })

  it('refuses a write that names no session, and a handle it never issued', async () => {
    const dataRoot = await createRoot()
    const owner = new ArtifactTurnOwner({
      dataRoot,
      repository: new ArtifactRepository(dataRoot),
      runRegistry: new ArtifactRunRegistry(),
      now: () => 1_600
    })

    // An empty session id is not a session: falling through to "no active turn" is what keeps a write from
    // being attached to whichever turn happens to be in the map.
    await expect(owner.writeForActiveTurn('', { filename: 'x.txt', content: 'x' })).rejects.toThrow(
      /No active assistant turn/i
    )
    expect(() => owner.snapshot({} as ArtifactTurnHandle)).toThrow(/Unknown Artifact turn handle/u)
  })
})
