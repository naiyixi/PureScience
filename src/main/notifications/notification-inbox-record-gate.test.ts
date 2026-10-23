import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { PrismaClient } from '@prisma/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createProjectDbClient, ensureProjectSchema } from '../projects/prisma-client'
import { createNotificationInboxController } from './notification-inbox-controller'
import { NotificationInboxDbRepository } from './notification-inbox-repository'

// The two gates in front of writing a notice used to drop it with a bare `return`. Both are legitimate —
// a notice for a session the reader deleted must not come back, and one for a session the app cannot
// resolve has no owner to read it — but the record path is fire-and-forget, so a silent drop is
// indistinguishable from "the notice was never produced". That is exactly the reading a P0 run produced
// on 2026-10-22: the permission request was logged as received, no `authorization.required` row reached
// the inbox, and nothing in the log said which of the three possible reasons it was. These cases pin the
// named reason onto each gate, and pin that the gates do not fire when neither applies.
const { infoLogSpy, warnLogSpy } = vi.hoisted(() => ({
  infoLogSpy: vi.fn(),
  warnLogSpy: vi.fn()
}))
vi.mock('../logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../logger')>()
  return {
    ...actual,
    createLogger: (scope: string) => ({
      ...actual.createLogger(scope),
      info: infoLogSpy,
      warn: warnLogSpy
    })
  }
})

let storageRoot: string | undefined
let client: PrismaClient | undefined

const createRepository = async (): Promise<NotificationInboxDbRepository> => {
  storageRoot = await mkdtemp(join(tmpdir(), 'purescience-notification-gate-'))
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
  infoLogSpy.mockClear()
  warnLogSpy.mockClear()
})

const droppedReason = (): string | undefined => {
  const call = [...infoLogSpy.mock.calls, ...warnLogSpy.mock.calls].find(([message]) =>
    String(message).startsWith('notification dropped:')
  )

  return call?.[0] as string | undefined
}

const authorizationNotice = (
  sessionId: string
): Parameters<ReturnType<typeof createNotificationInboxController>['record']>[0] => ({
  dedupeKey: `authorization.required:${sessionId}:request-1`,
  kind: 'authorization.required',
  source: 'agent-tool',
  sessionId,
  originId: 'request-1',
  title: 'Authorization required',
  summary: 'The agent requests a sensitive operation',
  actionState: 'pending'
})

describe('the inbox record gate', () => {
  it('names the reason when the session was deleted', async () => {
    const repository = await createRepository()
    const controller = createNotificationInboxController({
      headless: true,
      repository,
      onChanged: () => undefined
    })
    await controller.deleteSessions(['session-gone'])

    await controller.record(authorizationNotice('session-gone'))

    expect(droppedReason()).toBe('notification dropped: its session was deleted')
    await expect(controller.getSnapshot()).resolves.toMatchObject({ items: [] })
  })

  it('names the reason when the app cannot resolve the session', async () => {
    const repository = await createRepository()
    const controller = createNotificationInboxController({
      headless: true,
      repository,
      onChanged: () => undefined
    })
    controller.setSessionAvailability(() => Promise.resolve(false))

    await controller.record(authorizationNotice('session-unknown'))

    expect(droppedReason()).toBe('notification dropped: its session is not available')
    expect(warnLogSpy).toHaveBeenCalledWith('notification dropped: its session is not available', {
      kind: 'authorization.required',
      sessionId: 'session-unknown'
    })
    await expect(controller.getSnapshot()).resolves.toMatchObject({ items: [] })
  })

  it('records the notice and names nothing when neither gate applies', async () => {
    const repository = await createRepository()
    const controller = createNotificationInboxController({
      headless: true,
      repository,
      onChanged: () => undefined
    })
    controller.setSessionAvailability(() => Promise.resolve(true))

    await controller.record(authorizationNotice('session-live'))

    expect(droppedReason()).toBeUndefined()
    const snapshot = await controller.getSnapshot()
    expect(snapshot.items.map((item) => item.kind)).toEqual(['authorization.required'])
    // A pending authorization is unread work, not something the app may mark read behind the reader.
    expect(snapshot.unreadCount).toBe(1)
  })
})
