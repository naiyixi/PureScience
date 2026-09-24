import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import {
  CompletionGateCoordinator,
  runCompletionGatedTool,
  type CompletionGateRuntime,
  type TrustedToolCompletionContext
} from './completion-gate'
import {
  CompletionHandoffLifecycle,
  FileCompletionHandoffRepository,
  InMemoryCompletionHandoffRepository
} from './completion-handoff-lifecycle'
import { toHandoffLifecycleEvent } from './handoff-lifecycle-adapter'

// U29 follow-up: the adapter must carry REAL owner records, not just synthetic fixtures. This drives the
// production composition — the real gate over the real `CompletionHandoffLifecycle` (the flavor
// `src/main/ipc.ts:939-942` installs), not the notifier-only coordinator — and then reads the window's
// seam shape back out of it. An array that is never anything but empty would be a shell.

const trustedContext: TrustedToolCompletionContext = {
  sessionId: 'session-1',
  turnId: 'turn-1',
  controlInvocationGeneration: 1,
  toolInvocationId: 'tool-1',
  originatingUserMessageId: 'user-1',
  attachmentIds: ['upload-1'],
  artifactIds: ['artifact-1']
}

const createRuntime = (): CompletionGateRuntime => ({
  stopOldPrompt: vi.fn(async () => undefined),
  waitForOwnershipRelease: vi.fn(async () => undefined),
  reconfigure: vi.fn(async () => undefined),
  continueAsApproved: vi.fn(async () => undefined),
  reportHandoffFailure: vi.fn(async () => undefined)
})

describe('handoff lifecycle seam over real owner records', () => {
  it('projects a captured handoff into the window shape with its real phase and target', async () => {
    const runtime = createRuntime()
    // Production installs the file-backed repository (src/main/ipc.ts:906), so this reads the seam back
    // through the durable path rather than an in-memory convenience.
    const storageDir = await mkdtemp(join(tmpdir(), 'handoff-seam-'))
    const owner = new CompletionHandoffLifecycle(
      new FileCompletionHandoffRepository(storageDir),
      runtime
    )
    const coordinator = new CompletionGateCoordinator(runtime, owner)
    coordinator.arm(trustedContext, 'Data analyst')

    await runCompletionGatedTool({
      coordinator,
      context: trustedContext,
      deliverToCurrentPrompt: async () => undefined,
      execute: async () => ({ rows: 42 })
    })

    const records = await owner.getEvents('session-1')
    expect(records.length).toBeGreaterThan(0)

    // The owner projects ONE event per durable handoff, carrying that handoff's CURRENT stage
    // (`completion-handoff-lifecycle.ts:597-607` reads the repository and maps `phase: handoff.stage`),
    // so a handoff that already continued reports `continued` rather than replaying every stage it passed
    // through. The seam therefore shows the window each handoff's state, not a stage log.
    const projected = records.map(toHandoffLifecycleEvent)
    expect(projected.every((event) => event.sessionId === 'session-1')).toBe(true)
    expect(projected.map((event) => event.phase)).toEqual(['continued'])
    expect(projected[0]?.target).toEqual({ kind: 'specialist', name: 'Data analyst' })
    expect(projected[0]?.provenance.originatingTurnId).toBe('turn-1')
    // The seam's ordering promise: never regress across the records it hands the window.
    const sequences = projected.map((event) => event.sequence)
    expect([...sequences].sort((left, right) => left - right)).toEqual(sequences)
  })

  it('hands the window a handoff that is still waiting for approval', async () => {
    const owner = new CompletionHandoffLifecycle(
      new InMemoryCompletionHandoffRepository(),
      createRuntime()
    )
    // `onAwaitingApproval` (completion-handoff-lifecycle.ts:344) is the production entry point for the
    // pending state — AgentsService calls it through `approvalLifecycle` before the permission card shows,
    // and it is what writes the durable `awaiting-approval` record the window has to render.
    await owner.onAwaitingApproval({
      sessionId: 'session-1',
      turnId: 'turn-1',
      controlInvocationGeneration: 1,
      originatingTurnId: 'turn-1',
      originatingUserMessageId: 'user-1',
      toolInvocationId: 'tool-1',
      target: { kind: 'specialist', name: 'Data analyst' },
      attachmentIds: ['upload-1'],
      artifactIds: ['artifact-1']
    })

    const projected = (await owner.getEvents('session-1')).map(toHandoffLifecycleEvent)
    expect(projected).toHaveLength(1)
    expect(projected[0]?.phase).toBe('awaiting-approval')
    expect(projected[0]?.target).toEqual({ kind: 'specialist', name: 'Data analyst' })
  })

  it('stays empty for a session that has no handoff, rather than inventing one', async () => {
    const owner = new CompletionHandoffLifecycle(
      new InMemoryCompletionHandoffRepository(),
      createRuntime()
    )
    expect(await owner.getEvents('session-without-handoffs')).toEqual([])
  })
})
