import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { PrismaClient } from '@prisma/client'
import { afterEach, describe, expect, it } from 'vitest'

import { createProjectDbClient, ensureProjectSchema } from '../projects/prisma-client'
import { createNotificationInboxController } from './notification-inbox-controller'
import { NotificationInboxDbRepository } from './notification-inbox-repository'
import {
  requireNotificationClearRequest,
  requireNotificationDeleteRequest
} from './notification-inbox-requests'

// The reader's own deletions, against a real SQLite inbox: the panel action only means something if the
// row is gone from storage afterwards, and if removing a card leaves what it pointed at alone.
let storageRoot: string | undefined
let client: PrismaClient | undefined

const createRepository = async (): Promise<NotificationInboxDbRepository> => {
  storageRoot = await mkdtemp(join(tmpdir(), 'purescience-notification-clear-'))
  client = createProjectDbClient(storageRoot)
  await ensureProjectSchema(client)

  return new NotificationInboxDbRepository(() => Promise.resolve(client!))
}

afterEach(async () => {
  await client?.$disconnect()
  client = undefined

  if (storageRoot) {
    await rm(storageRoot, { recursive: true, force: true })
    storageRoot = undefined
  }
})

let idCounter = 0

const createController = (
  repository: NotificationInboxDbRepository
): ReturnType<typeof createNotificationInboxController> =>
  createNotificationInboxController({
    headless: true,
    repository,
    onChanged: () => undefined,
    createId: () => `generated-${(idCounter += 1)}`,
    now: () => 1_700_000_000_000
  })

const seedThree = async (repository: NotificationInboxDbRepository): Promise<void> => {
  await repository.record({
    id: 'notif-1',
    dedupeKey: 'key-1',
    kind: 'task.completed',
    sessionId: 'session-1',
    originId: 'origin-1',
    title: 'Task completed',
    summary: 'A deterministic reply finished.'
  })
  await repository.record({
    id: 'notif-2',
    dedupeKey: 'key-2',
    kind: 'task.failed',
    originId: 'origin-2',
    title: 'Task failed',
    summary: 'A run stopped early.'
  })
  await repository.record({
    id: 'notif-3',
    dedupeKey: 'key-3',
    kind: 'task.needs-attention',
    sessionId: 'session-2',
    originId: 'origin-3',
    title: 'Background result needs attention',
    summary: 'A finished result could not be delivered.'
  })
}

const storedIds = async (): Promise<string[]> => {
  const rows = await client!.notificationInboxItem.findMany({ orderBy: { sequence: 'asc' } })
  return rows.map((row) => row.id)
}

describe('notification inbox repository — reader deletions', () => {
  it('removes exactly the rows the reader named and leaves the rest', async () => {
    const repository = await createRepository()
    await seedThree(repository)

    await repository.deleteItems(['notif-2'])

    expect(await storedIds()).toEqual(['notif-1', 'notif-3'])
    await expect(repository.snapshot()).resolves.toMatchObject({
      unreadCount: 2,
      latestSequence: 3
    })
  })

  it('ignores blank and repeated ids instead of sweeping the inbox', async () => {
    const repository = await createRepository()
    await seedThree(repository)

    await repository.deleteItems(['', '   '])
    expect(await storedIds()).toEqual(['notif-1', 'notif-2', 'notif-3'])

    await repository.deleteItems(['notif-1', 'notif-1', ' notif-1 '])
    expect(await storedIds()).toEqual(['notif-2', 'notif-3'])
  })

  it('stops at the sequence the reader confirmed, so a later notice survives', async () => {
    const repository = await createRepository()
    await seedThree(repository)

    await repository.clearAll(2)

    expect(await storedIds()).toEqual(['notif-3'])
    await expect(repository.snapshot()).resolves.toMatchObject({
      unreadCount: 1,
      latestSequence: 3
    })
  })

  it('clears nothing when the boundary is zero or nonsense', async () => {
    const repository = await createRepository()
    await seedThree(repository)

    await repository.clearAll(0)
    await repository.clearAll(Number.NaN)

    expect(await storedIds()).toEqual(['notif-1', 'notif-2', 'notif-3'])
  })

  it('clears read and unread rows alike — it is not a mark-all-read', async () => {
    const repository = await createRepository()
    await seedThree(repository)
    await repository.markRead(['notif-2'], 1_700_000_000_001)

    await repository.clearAll(3)

    expect(await storedIds()).toEqual([])
    await expect(repository.snapshot()).resolves.toMatchObject({ unreadCount: 0 })
  })
})

describe('notification inbox controller — reader deletions', () => {
  it('never suppresses the next notice for a conversation, unlike a session deletion', async () => {
    const repository = await createRepository()
    await seedThree(repository)
    const controller = createController(repository)

    // Tidying the centre is about the cards, so the conversation keeps producing notices…
    await controller.deleteItems(['notif-1'])
    await controller.record({
      dedupeKey: 'key-4',
      kind: 'task.completed',
      sessionId: 'session-1',
      originId: 'origin-4',
      title: 'Task completed',
      summary: 'Another turn finished.'
    })
    const afterDelete = await controller.getSnapshot()
    expect(afterDelete.items.map((item) => item.dedupeKey)).toContain('key-4')

    // …while a session deletion is the one that silences it.
    await controller.deleteSessions(['session-1'])
    await controller.record({
      dedupeKey: 'key-5',
      kind: 'task.completed',
      sessionId: 'session-1',
      originId: 'origin-5',
      title: 'Task completed',
      summary: 'A notice for a deleted conversation.'
    })
    const afterSessionDelete = await controller.getSnapshot()
    expect(afterSessionDelete.items.map((item) => item.dedupeKey)).not.toContain('key-5')
  })

  it('publishes the new unread count after a clear, so every rendered bell converges', async () => {
    const repository = await createRepository()
    await seedThree(repository)
    const changes: number[] = []
    const controller = createNotificationInboxController({
      headless: true,
      repository,
      onChanged: (event) => changes.push(event.unreadCount),
      createId: () => `generated-${(idCounter += 1)}`,
      now: () => 1_700_000_000_000
    })

    await controller.clearAll(1)

    expect(changes).toEqual([2])
    await expect(controller.getSnapshot()).resolves.toMatchObject({ unreadCount: 2 })
  })

  it('refuses malformed requests by naming the channel that rejected them', () => {
    expect(requireNotificationDeleteRequest({ ids: ['a'] })).toEqual({ ids: ['a'] })
    expect(() => requireNotificationDeleteRequest({ ids: [1] })).toThrow(
      'Invalid notifications:delete-items request.'
    )
    expect(() => requireNotificationDeleteRequest({})).toThrow(
      'Invalid notifications:delete-items request.'
    )

    expect(requireNotificationClearRequest({ throughSequence: 0 })).toEqual({ throughSequence: 0 })
    for (const bad of [
      {},
      { throughSequence: -1 },
      { throughSequence: 1.5 },
      { throughSequence: '3' }
    ]) {
      expect(() => requireNotificationClearRequest(bad)).toThrow(
        'Invalid notifications:clear-all request.'
      )
    }
  })
})
