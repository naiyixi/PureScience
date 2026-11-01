// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  NotificationInboxChanged,
  NotificationInboxSnapshot
} from '../../../shared/notifications'
import { EMPTY_SNAPSHOT, useNotificationInboxStore } from './notification-inbox-store'

// The message centre's read policy, pinned where it lives.
//
// The change feed carries the two numbers the bell paints (`unreadCount`, `latestSequence`) plus the
// revision of the state it describes. Before this the listener threw all three away and re-read the whole
// list on every event, and every mutation read it a second time on its own. On a real machine
// `notifications:get-snapshot` is one of the slowest channels in the log, so each of those reads is time the
// main process spends instead of the turn the reader is waiting for.
//
// What these cases hold: a burst is one read, a revision already on screen is zero reads, and the two
// numbers on the bell still move immediately. Numerics are asserted from the payload, never re-derived.

let listener: ((change?: NotificationInboxChanged) => void) | undefined
let snapshot: NotificationInboxSnapshot
let getSnapshot: ReturnType<typeof vi.fn>
let stop: (() => void) | undefined

const drain = async (): Promise<void> => {
  // `requestRefresh` merges on a macro-task; two turns of the loop settle the timer and the queued read.
  for (let turn = 0; turn < 3; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

const installBridge = (): void => {
  getSnapshot = vi.fn(async () => snapshot)
  ;(window as unknown as { api?: unknown }).api = {
    notifications: {
      clearAll: vi.fn(async () => undefined),
      deleteItems: vi.fn(async () => undefined),
      getSnapshot,
      markAllRead: vi.fn(async () => undefined),
      markRead: vi.fn(async () => undefined),
      markSessionCompletionsRead: vi.fn(async () => undefined),
      onChanged: vi.fn((registered: (change?: NotificationInboxChanged) => void) => {
        listener = registered
        return () => {
          listener = undefined
        }
      })
    }
  }
}

beforeEach(() => {
  useNotificationInboxStore.setState({ ...EMPTY_SNAPSHOT, status: 'idle', error: undefined })
  snapshot = { revision: 1, unreadCount: 0, latestSequence: 0, items: [] }
  listener = undefined
  stop = undefined
  installBridge()
})

afterEach(() => {
  stop?.()
  stop = undefined
  delete (window as unknown as { api?: unknown }).api
  useNotificationInboxStore.setState({ ...EMPTY_SNAPSHOT, status: 'idle', error: undefined })
})

const listen = async (): Promise<void> => {
  stop = useNotificationInboxStore.getState().listen()
  await drain()
}

describe('message centre read policy', () => {
  it('paints the badge from the payload and reads the rows once per burst', async () => {
    await listen()
    expect(getSnapshot).toHaveBeenCalledTimes(1)

    // Three arrivals in one tick — the numbers are on the event, so the bell moves at once…
    listener?.({ revision: 2, unreadCount: 1, latestSequence: 1 })
    listener?.({ revision: 3, unreadCount: 2, latestSequence: 2 })
    listener?.({ revision: 4, unreadCount: 3, latestSequence: 3 })
    expect(useNotificationInboxStore.getState().unreadCount).toBe(3)
    expect(useNotificationInboxStore.getState().latestSequence).toBe(3)

    // …and the whole burst costs one read of the list.
    await drain()
    expect(getSnapshot).toHaveBeenCalledTimes(2)
  })

  it('costs no read for a revision that is already on screen', async () => {
    snapshot = { revision: 5, unreadCount: 2, latestSequence: 5, items: [] }
    await listen()
    expect(getSnapshot).toHaveBeenCalledTimes(1)

    // A replay of the state the reader is looking at: nothing to fetch.
    listener?.({ revision: 5, unreadCount: 2, latestSequence: 5 })
    await drain()
    expect(getSnapshot).toHaveBeenCalledTimes(1)

    // An older revision is a replay too.
    listener?.({ revision: 4, unreadCount: 2, latestSequence: 4 })
    await drain()
    expect(getSnapshot).toHaveBeenCalledTimes(1)

    // A newer one is not.
    listener?.({ revision: 6, unreadCount: 0, latestSequence: 6 })
    await drain()
    expect(getSnapshot).toHaveBeenCalledTimes(2)
  })

  it('does not read twice for a mutation and the change it causes', async () => {
    snapshot = { revision: 3, unreadCount: 4, latestSequence: 4, items: [] }
    await listen()
    const api = window.api?.notifications
    const markAllRead = api?.markAllRead as ReturnType<typeof vi.fn>
    // Main publishes the change while the call is in flight — the event and the mutation's own refresh
    // describe the same state, so they must share one read.
    markAllRead.mockImplementation(async () => {
      listener?.({ revision: 4, unreadCount: 0, latestSequence: 4 })
    })

    await useNotificationInboxStore.getState().markAllRead()
    await drain()
    expect(getSnapshot).toHaveBeenCalledTimes(2)
  })

  it('still reads when the event carries no numbers, and never invents a count', async () => {
    snapshot = { revision: 9, unreadCount: 1, latestSequence: 9, items: [] }
    await listen()
    expect(getSnapshot).toHaveBeenCalledTimes(1)

    // A payload without the fields (older main, or a future event shape) must fall through to the read
    // rather than leave the bell showing a number nobody measured.
    listener?.(undefined)
    await drain()
    expect(getSnapshot).toHaveBeenCalledTimes(2)
    expect(useNotificationInboxStore.getState().unreadCount).toBe(1)
  })

  it('keeps the failure visible and recovers on the next change', async () => {
    getSnapshot.mockRejectedValueOnce(new Error('inbox unavailable'))
    await listen()
    expect(useNotificationInboxStore.getState().status).toBe('error')
    expect(useNotificationInboxStore.getState().error).toBe('inbox unavailable')

    snapshot = { revision: 2, unreadCount: 1, latestSequence: 1, items: [] }
    listener?.({ revision: 2, unreadCount: 1, latestSequence: 1 })
    await drain()
    expect(useNotificationInboxStore.getState().status).toBe('ready')
    expect(useNotificationInboxStore.getState().error).toBeUndefined()
  })
})
