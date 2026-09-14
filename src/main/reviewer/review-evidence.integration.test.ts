// Real DB, real session file, no mocks: proves the evidence chain end to end at the service layer —
// a captured fingerprint, a pin written into SQLite, read back with its identity, and a tampered block
// detected afterwards. Runs entirely against a temporary data root; it never touches the user's data.
//
// This is deliberately not the top layer: an agent-turn proof would additionally require a real review
// run. What it does establish is that the write path lands and the read path returns what was written.

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createSearchEvidenceService } from '../search/search-evidence'
import { toSearchableMessages } from '../search/handlers'
import type { PersistedChatSession } from '../../shared/session-persistence'
import { disconnectProjectDbClient, getProjectDbClient } from '../projects/prisma-client'
import { ReviewRepository } from './repository'
import { createReviewEvidenceService } from './review-evidence-service'

const MESSAGE_TEXT = 'I wrote sin(x) values into replay_probe.csv'

let root: string
let sessionPath: string

const writeSession = async (text: string): Promise<void> => {
  const persisted = {
    version: 2,
    session: {
      id: 'session-a',
      projectId: 'project-a',
      title: 'Sine analysis',
      messages: [
        { id: 'message-2', role: 'agent', content: text, createdAt: 1, updatedAt: 1, eventIds: [] }
      ],
      activities: [],
      createdAt: 1,
      updatedAt: 2
    }
  }
  await mkdir(join(root, 'sessions', 'project-a'), { recursive: true })
  await writeFile(sessionPath, JSON.stringify(persisted), 'utf8')
}

// Reads the session from disk the way the app does, rather than handing the services a fixture object.
const readSessionMessages = async (): Promise<ReturnType<typeof toSearchableMessages>> => {
  const raw = JSON.parse(await readFile(sessionPath, 'utf8')) as { session: PersistedChatSession }
  return toSearchableMessages(raw.session)
}

// One data root for the whole file: the SQLite client is cached per root, so removing the root between
// tests would leave the next test writing into a deleted database.
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'purescience-evidence-integration-'))
  sessionPath = join(root, 'sessions', 'project-a', 'session-a.json')
  await writeSession(MESSAGE_TEXT)
})

afterAll(async () => {
  await disconnectProjectDbClient().catch(() => undefined)
  await rm(root, { recursive: true, force: true })
})

describe('evidence chain against a real database and a real session file', () => {
  it('captures, pins, reads back, and detects a changed block', async () => {
    const reviews = new ReviewRepository(() => getProjectDbClient(root), {})
    const review = await reviews.createReview({
      projectId: 'project-a',
      sessionId: 'session-a',
      turnMessageId: 'turn-1',
      scope: { turnMessageId: 'turn-1', blocks: [], artifactVersionIds: [] },
      model: 'test-model'
    })

    const searchEvidence = createSearchEvidenceService({ readSessionMessages })
    const evidence = createReviewEvidenceService({
      reviews: {
        findReviewById: (reviewId) => reviews.findReviewById(reviewId),
        listReviewEvidence: (reviewIds) => reviews.listReviewEvidence(reviewIds),
        appendReviewEvidence: (input) => reviews.appendReviewEvidence(input)
      },
      searchEvidence
    })

    const captured = await searchEvidence.capture({
      action: 'capture',
      projectId: 'project-a',
      sessionId: 'session-a',
      messageId: 'message-2',
      query: 'sin csv',
      terms: ['sin', 'csv']
    })
    expect(captured.status).toBe('captured')
    if (captured.status !== 'captured') return
    const line = captured.line
    expect(line.role).toBe('agent')

    // The pin lands in SQLite.
    const attached = await evidence.attach({ action: 'attach', reviewId: review.id, line })
    expect(attached.status).toBe('attached')

    // And reads back with the identity it was written with.
    const listed = await evidence.list([review.id])
    expect(listed.attachments).toHaveLength(1)
    expect(listed.attachments[0]).toMatchObject({
      reviewId: review.id,
      projectId: 'project-a',
      sessionId: 'session-a',
      messageId: 'message-2',
      role: 'agent',
      fingerprint: line.fingerprint,
      query: 'sin csv',
      terms: ['sin', 'csv'],
      snippet: MESSAGE_TEXT
    })

    // Re-pinning the same block to the same review is refused by fingerprint.
    await expect(evidence.attach({ action: 'attach', reviewId: review.id, line })).resolves.toEqual(
      {
        status: 'rejected',
        reason: 'already-attached'
      }
    )

    // The block still verifies...
    await expect(searchEvidence.verify(line)).resolves.toEqual({
      status: 'verified',
      fingerprint: line.fingerprint
    })

    // ...until the stored text changes, at which point the pin is reported as changed, not as holding.
    await writeSession(`${MESSAGE_TEXT} (edited after the pin)`)
    const afterEdit = await searchEvidence.verify(line)
    expect(afterEdit.status).toBe('unavailable')
    if (afterEdit.status !== 'unavailable') return
    expect(afterEdit.reason).toBe('fingerprint-mismatch')
    expect(afterEdit.fingerprintNow).not.toBe(line.fingerprint)
  })

  it('refuses to pin a line whose block is not in that review session', async () => {
    const reviews = new ReviewRepository(() => getProjectDbClient(root), {})
    const other = await reviews.createReview({
      projectId: 'project-b',
      sessionId: 'session-b',
      turnMessageId: 'turn-1',
      scope: { turnMessageId: 'turn-1', blocks: [], artifactVersionIds: [] },
      model: 'test-model'
    })

    const searchEvidence = createSearchEvidenceService({ readSessionMessages })
    const evidence = createReviewEvidenceService({
      reviews: {
        findReviewById: (reviewId) => reviews.findReviewById(reviewId),
        listReviewEvidence: (reviewIds) => reviews.listReviewEvidence(reviewIds),
        appendReviewEvidence: (input) => reviews.appendReviewEvidence(input)
      },
      searchEvidence
    })
    const captured = await searchEvidence.capture({
      action: 'capture',
      projectId: 'project-a',
      sessionId: 'session-a',
      messageId: 'message-2',
      query: 'sin'
    })
    if (captured.status !== 'captured') throw new Error('capture failed')

    // Ownership comes from the review row, so the pin cannot be filed onto another project's review.
    await expect(
      evidence.attach({ action: 'attach', reviewId: other.id, line: captured.line })
    ).resolves.toEqual({ status: 'rejected', reason: 'project-mismatch' })
    await expect(evidence.list([other.id])).resolves.toEqual({ attachments: [] })
  })
})
