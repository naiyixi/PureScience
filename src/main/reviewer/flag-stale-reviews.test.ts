import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createLinearConversationGraph } from '../../shared/conversation-graph'
import type { ReviewWithChecks } from '../../shared/reviewer'
import type { PersistedChatSession } from '../../shared/session-persistence'
import { flagStaleReviews } from './stale-reviews'
import { resolveTurnScopeWithArtifactDigests } from './artifact-digest'

let storageRoot: string | undefined

afterEach(async () => {
  if (storageRoot) {
    await rm(storageRoot, { recursive: true, force: true })
    storageRoot = undefined
  }
})

const buildSession = (): PersistedChatSession => ({
  id: 'session-1',
  projectId: 'project-1',
  title: 'Session',
  cwd: '/tmp',
  status: 'idle',
  messages: [
    {
      id: 'u1',
      role: 'user',
      content: 'go',
      status: 'complete',
      eventIds: [],
      createdAt: 1000,
      updatedAt: 1000
    },
    {
      id: 'a1',
      role: 'agent',
      content: 'done',
      status: 'complete',
      eventIds: [],
      artifactIds: ['session-1:a1:report.csv'],
      createdAt: 1002,
      updatedAt: 1002
    }
  ],
  createdAt: 1000,
  updatedAt: 1002
})

const buildReview = (
  scope: Awaited<ReturnType<typeof resolveTurnScopeWithArtifactDigests>>,
  overrides: Partial<ReviewWithChecks> = {}
): ReviewWithChecks => ({
  id: 'review-1',
  projectId: 'project-1',
  sessionId: 'session-1',
  turnMessageId: 'a1',
  scope,
  lifecycle: 'complete',
  outcome: 'pass',
  model: 'test',
  reviewerLog: [],
  checks: [],
  createdAt: 1000,
  updatedAt: 1000,
  ...overrides
})

const writeArtifact = async (root: string, contents: string): Promise<void> => {
  const dir = join(root, 'artifacts', 'project-1', 'session-1', 'a1')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'report.csv'), contents, 'utf8')
}

describe('flagStaleReviews', () => {
  it('flags a completed review when the artifact it audited was edited afterward', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'flag-stale-'))
    const session = buildSession()
    await writeArtifact(storageRoot, 'a,b\n1,2\n')
    const scopeAtReviewTime = await resolveTurnScopeWithArtifactDigests(session, 'a1', storageRoot)
    const review = buildReview(scopeAtReviewTime)

    // The artifact is edited outside the app after the review completed.
    await writeArtifact(storageRoot, 'a,b\n9,9\n')

    const [flagged] = await flagStaleReviews([review], session, storageRoot)

    expect(flagged.stale).toBe(true)
  })

  it('does not flag a completed review when nothing about its turn has changed', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'flag-stale-'))
    const session = buildSession()
    await writeArtifact(storageRoot, 'a,b\n1,2\n')
    const scope = await resolveTurnScopeWithArtifactDigests(session, 'a1', storageRoot)
    const review = buildReview(scope)

    const [result] = await flagStaleReviews([review], session, storageRoot)

    // Computed-not-stale is an explicit false (distinct from "couldn't compute" = undefined).
    expect(result.stale).toBe(false)
  })

  it('never flags a running or errored review (no verdict to invalidate)', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'flag-stale-'))
    const session = buildSession()
    await writeArtifact(storageRoot, 'a,b\n1,2\n')
    const scope = await resolveTurnScopeWithArtifactDigests(session, 'a1', storageRoot)
    const running = buildReview(scope, { lifecycle: 'running', outcome: null })
    const errored = buildReview(scope, { lifecycle: 'error', outcome: null })

    await writeArtifact(storageRoot, 'a,b\n9,9\n')

    const [flaggedRunning, flaggedErrored] = await flagStaleReviews(
      [running, errored],
      session,
      storageRoot
    )

    expect(flaggedRunning.stale).toBeUndefined()
    expect(flaggedErrored.stale).toBeUndefined()
  })

  it('fails open (unflagged) when the session is missing, instead of hiding the verdict', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'flag-stale-'))
    const session = buildSession()
    await writeArtifact(storageRoot, 'a,b\n1,2\n')
    const scope = await resolveTurnScopeWithArtifactDigests(session, 'a1', storageRoot)
    const review = buildReview(scope)

    const [result] = await flagStaleReviews([review], undefined, storageRoot)

    expect(result.stale).toBeUndefined()
  })

  it('fails closed when active-session Artifact evidence cannot be recomputed', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'flag-stale-unavailable-'))
    const session = buildSession()
    await writeArtifact(storageRoot, 'a,b\n1,2\n')
    const scope = await resolveTurnScopeWithArtifactDigests(session, 'a1', storageRoot)
    const review = buildReview(scope)
    await rm(join(storageRoot, 'artifacts'), { recursive: true, force: true })

    const [result] = await flagStaleReviews([review], session, storageRoot)

    expect(result.stale).toBe(true)
  })

  it('recomputes against scope.turnMessageId, so a fix-loop review is not falsely stale', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'flag-stale-'))
    const session = buildSession()
    await writeArtifact(storageRoot, 'a,b\n1,2\n')

    // A fix-loop re-review: its SCOPE is the correction turn (a1), but the row is grouped under the
    // ORIGINAL turn id (u1). Recomputing with review.turnMessageId (u1) would resolve a different turn
    // and always mismatch; recomputing with scope.turnMessageId (a1) correctly matches when unchanged.
    const scope = await resolveTurnScopeWithArtifactDigests(session, 'a1', storageRoot)
    const fixLoopReview = buildReview(scope, { turnMessageId: 'u1' })

    const [result] = await flagStaleReviews([fixLoopReview], session, storageRoot)

    // Correctly resolves the correction turn (a1) and finds it unchanged → explicit not-stale.
    expect(result.stale).toBe(false)
  })

  it('recomputes one scope for reviews of the same turn instead of one per review', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'flag-stale-shared-'))
    const session = buildSession()
    await writeArtifact(storageRoot, 'a,b\n1,2\n')
    const scope = await resolveTurnScopeWithArtifactDigests(session, 'a1', storageRoot)
    // The shape a real Session produces: a fix-loop re-review of the same turn, grouped with the first.
    const first = buildReview(scope)
    const reReview = buildReview(scope, { id: 'review-2' })
    const artifactPath = join(
      storageRoot,
      'artifacts',
      'project-1',
      'session-1',
      'a1',
      'report.csv'
    )
    let versionResolves = 0
    const stats = { scopeComputations: 0, scopeReuses: 0 }

    const [flaggedFirst, flaggedReReview] = await flagStaleReviews(
      [first, reReview],
      session,
      storageRoot,
      () => {
        versionResolves += 1
        return Promise.resolve({ path: artifactPath, filename: 'report.csv' })
      },
      stats
    )

    // The artifact bytes and the version lookup are read once for the pair, not once per review.
    expect(versionResolves).toBe(1)
    expect(stats).toEqual({ scopeComputations: 1, scopeReuses: 1 })
    expect(flaggedFirst.stale).toBe(false)
    expect(flaggedReReview.stale).toBe(false)
  })

  it('still recomputes separately for reviews of different turns', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'flag-stale-distinct-'))
    const session = buildSession()
    session.messages.push({
      id: 'a2',
      role: 'agent',
      content: 'second answer',
      status: 'complete',
      eventIds: [],
      artifactIds: [],
      createdAt: 1003,
      updatedAt: 1003
    })
    await writeArtifact(storageRoot, 'a,b\n1,2\n')
    const firstScope = await resolveTurnScopeWithArtifactDigests(session, 'a1', storageRoot)
    const secondScope = await resolveTurnScopeWithArtifactDigests(session, 'a2', storageRoot)
    const stats = { scopeComputations: 0, scopeReuses: 0 }

    const [flaggedFirst, flaggedSecond] = await flagStaleReviews(
      [buildReview(firstScope), buildReview(secondScope, { id: 'review-2', turnMessageId: 'a2' })],
      session,
      storageRoot,
      undefined,
      stats
    )

    expect(stats).toEqual({ scopeComputations: 2, scopeReuses: 0 })
    expect(flaggedFirst.stale).toBe(false)
    expect(flaggedSecond.stale).toBe(false)
  })

  it('fails closed on every review sharing a turn whose evidence cannot be recomputed', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'flag-stale-shared-unavailable-'))
    const session = buildSession()
    await writeArtifact(storageRoot, 'a,b\n1,2\n')
    const scope = await resolveTurnScopeWithArtifactDigests(session, 'a1', storageRoot)
    const first = buildReview(scope)
    const reReview = buildReview(scope, { id: 'review-2' })
    await rm(join(storageRoot, 'artifacts'), { recursive: true, force: true })
    const stats = { scopeComputations: 0, scopeReuses: 0 }

    const [flaggedFirst, flaggedReReview] = await flagStaleReviews(
      [first, reReview],
      session,
      storageRoot,
      undefined,
      stats
    )

    // A shared recomposition that failed is not shared as a success: both reviews fail closed, and the
    // same inputs are not retried for the second review.
    expect(flaggedFirst.stale).toBe(true)
    expect(flaggedReReview.stale).toBe(true)
    expect(stats).toEqual({ scopeComputations: 1, scopeReuses: 1 })
  })

  it('recomputes a historical review against its frozen Branch after the active Branch changes', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'flag-stale-historical-branch-'))
    const session = buildSession()
    const reviewedMessage = session.messages.find((message) => message.id === 'a1')!
    reviewedMessage.artifactIds = undefined
    const graph = createLinearConversationGraph({
      sessionId: session.id,
      messages: session.messages,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt
    })
    session.conversationGraph = graph
    const scope = await resolveTurnScopeWithArtifactDigests(session, 'a1', storageRoot)
    const review = buildReview(scope)

    const frame = graph.frames[0]
    const originalBranch = graph.branches[0]
    const runtimeSegmentId = graph.runtimeSegments[0].id
    const editedBranchId = 'edited-branch'
    graph.branches.push({
      id: editedBranchId,
      agentFrameId: frame.id,
      parentBranchId: originalBranch.id,
      supersededMessageId: 'u1',
      headMessageId: 'a1-edited',
      createdAt: 2000,
      updatedAt: 2002
    })
    graph.messages.push(
      {
        id: 'u1-edited',
        role: 'user',
        content: 'different prompt',
        status: 'complete',
        eventIds: [],
        createdAt: 2000,
        updatedAt: 2000,
        agentFrameId: frame.id,
        introducedOnBranchId: editedBranchId,
        revisionRootMessageId: 'u1',
        supersedesMessageId: 'u1',
        runtimeSegmentId
      },
      {
        id: 'a1-edited',
        role: 'agent',
        content: 'different answer',
        status: 'complete',
        eventIds: [],
        createdAt: 2002,
        updatedAt: 2002,
        agentFrameId: frame.id,
        introducedOnBranchId: editedBranchId,
        parentMessageId: 'u1-edited',
        runtimeSegmentId
      }
    )
    frame.activeBranchId = editedBranchId

    const [result] = await flagStaleReviews([review], session, storageRoot)

    expect(result.stale).toBe(false)
  })
})
