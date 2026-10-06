// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  NotificationInboxItem,
  NotificationInboxSnapshot
} from '../../../shared/notifications'
import { LanguageProvider } from '@/i18n'
import { EMPTY_SNAPSHOT, useNotificationInboxStore } from '@/stores/notification-inbox-store'
import { NotificationBell } from './NotificationBell'

// The two reader-owned deletions in the message centre. jsdom is enough for the interaction contract
// (what reaches the bridge, what the confirmation says, what a refusal does); the stored effect of those
// calls is pinned against a real SQLite inbox in src/main/notifications/notification-inbox-clear.test.ts.
let container: HTMLDivElement
let root: Root

type ItemSeed = Readonly<{
  id: string
  kind: NotificationInboxItem['kind']
  title: string
  sessionId?: string
}>

const toItems = (seeds: readonly ItemSeed[]): NotificationInboxItem[] =>
  seeds.map((seed, index) => ({
    id: seed.id,
    sequence: index + 1,
    dedupeKey: `key-${seed.id}`,
    kind: seed.kind,
    ...(seed.sessionId ? { sessionId: seed.sessionId } : {}),
    originId: seed.id,
    title: seed.title,
    summary: 'A finished background result.',
    createdAt: 1_700_000_000_000
  }))

const snapshotOf = (seeds: readonly ItemSeed[]): NotificationInboxSnapshot => {
  const items = toItems(seeds)
  return {
    revision: 1,
    unreadCount: items.length,
    latestSequence: items.length,
    items
  }
}

type Bridge = Readonly<{
  clearAll: ReturnType<typeof vi.fn>
  deleteItems: ReturnType<typeof vi.fn>
  getSnapshot: ReturnType<typeof vi.fn>
  markAllRead: ReturnType<typeof vi.fn>
  markRead: ReturnType<typeof vi.fn>
  markSessionCompletionsRead: ReturnType<typeof vi.fn>
  onChanged: ReturnType<typeof vi.fn>
}>

let bridge: Bridge
let centre: ItemSeed[]

const installBridge = (): void => {
  bridge = {
    clearAll: vi.fn(async () => undefined),
    deleteItems: vi.fn(async () => undefined),
    getSnapshot: vi.fn(async () => snapshotOf(centre)),
    markAllRead: vi.fn(async () => undefined),
    markRead: vi.fn(async () => undefined),
    markSessionCompletionsRead: vi.fn(async () => undefined),
    onChanged: vi.fn(() => () => undefined)
  }
  ;(window as unknown as { api?: unknown }).api = { notifications: bridge }
}

const render = (language?: string): void => {
  if (language) window.localStorage.setItem('purescience-language', language)
  act(() => {
    root.render(
      <LanguageProvider>
        <NotificationBell />
      </LanguageProvider>
    )
  })
}

const openCentre = async (): Promise<HTMLElement> => {
  const bell = document.querySelector<HTMLButtonElement>('[aria-label^="Messages"]')
  if (!bell) throw new Error('the bell was not rendered')
  await act(async () => {
    bell.click()
  })
  await act(async () => {
    await Promise.resolve()
  })
  const centrePanel = document.querySelector<HTMLElement>('[role="dialog"]')
  if (!centrePanel) throw new Error('the message centre did not open')
  return centrePanel
}

const clearAllButton = (): HTMLButtonElement | null =>
  document.querySelector<HTMLButtonElement>('[data-slot="notifications-clear-all"]')

const deleteButtons = (): HTMLButtonElement[] => [
  ...document.querySelectorAll<HTMLButtonElement>('[data-slot="notification-item-delete"]')
]

beforeEach(() => {
  window.localStorage.clear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  useNotificationInboxStore.setState({ ...EMPTY_SNAPSHOT, status: 'idle', error: undefined })
  centre = [
    { id: 'notif-1', kind: 'task.completed', title: 'Task completed', sessionId: 'session-1' },
    { id: 'notif-2', kind: 'task.failed', title: 'Task failed' }
  ]
  installBridge()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  delete (window as unknown as { api?: unknown }).api
  window.localStorage.clear()
  useNotificationInboxStore.setState({ ...EMPTY_SNAPSHOT, status: 'idle', error: undefined })
})

describe('message centre reader deletions', () => {
  it('removes exactly the card the reader pointed at and reloads the centre', async () => {
    render()
    await openCentre()

    expect(deleteButtons()).toHaveLength(2)
    expect(deleteButtons()[0]?.getAttribute('aria-label')).toBe(
      'Delete notification: Task completed'
    )

    centre = centre.filter((seed) => seed.id !== 'notif-1')
    await act(async () => {
      deleteButtons()[0]?.click()
    })

    expect(bridge.deleteItems).toHaveBeenCalledWith({ ids: ['notif-1'] })
    expect(bridge.getSnapshot).toHaveBeenCalledTimes(2)
    expect(deleteButtons()).toHaveLength(1)
  })

  it('clears only after a confirmation that says the conversations survive, and can be cancelled', async () => {
    render()
    await openCentre()
    expect(clearAllButton()?.disabled).toBe(false)

    await act(async () => {
      clearAllButton()?.click()
    })

    const warning = document.querySelector('[data-slot="notifications-clear-warning"]')
    expect(warning?.textContent).toBe(
      'This clears the messages listed here. Your conversations are not deleted. It cannot be undone.'
    )
    // Asking is not doing.
    expect(bridge.clearAll).not.toHaveBeenCalled()

    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-slot="notifications-clear-cancel"]')?.click()
    })
    expect(document.querySelector('[data-slot="notifications-clear-confirm"]')).toBeNull()
    expect(bridge.clearAll).not.toHaveBeenCalled()

    await act(async () => {
      clearAllButton()?.click()
    })
    centre = []
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>('[data-slot="notifications-clear-confirm-button"]')
        ?.click()
    })

    // Bounded by the sequence that was on screen when the reader confirmed.
    expect(bridge.clearAll).toHaveBeenCalledWith({ throughSequence: 2 })
    expect(deleteButtons()).toHaveLength(0)
  })

  it('offers no clearing action when the centre is empty', async () => {
    centre = []
    render()
    await openCentre()

    expect(clearAllButton()?.disabled).toBe(true)
  })

  it('renders the confirm copy in the interface language, not the English source text', async () => {
    render('zh')
    await openCentre()

    expect(clearAllButton()?.textContent).toContain('全部清除')

    await act(async () => {
      clearAllButton()?.click()
    })

    expect(document.querySelector('[data-slot="notifications-clear-warning"]')?.textContent).toBe(
      '这里列出的消息会被清除；会话本身不会被删除。此操作无法撤销。'
    )
    expect(document.body.textContent).not.toContain('This clears the messages listed here')
  })
})

describe('notification inbox store — reader deletions', () => {
  it('keeps a refused deletion visible instead of dropping it', async () => {
    bridge.deleteItems.mockRejectedValueOnce(
      new Error('Invalid notifications:delete-items request.')
    )
    useNotificationInboxStore.setState({ ...snapshotOf(centre), status: 'ready' })

    await act(async () => {
      await useNotificationInboxStore.getState().deleteItems(['notif-1'])
    })

    expect(useNotificationInboxStore.getState().status).toBe('error')
    expect(useNotificationInboxStore.getState().error).toBe(
      'Invalid notifications:delete-items request.'
    )
  })

  it('never reaches the bridge with blank ids or an empty centre', async () => {
    useNotificationInboxStore.setState({ ...snapshotOf(centre), status: 'ready' })

    await act(async () => {
      await useNotificationInboxStore.getState().deleteItems(['', '  '])
      await useNotificationInboxStore.getState().clearAll()
    })
    expect(bridge.deleteItems).not.toHaveBeenCalled()
    expect(bridge.clearAll).toHaveBeenCalledTimes(1)

    bridge.clearAll.mockClear()
    useNotificationInboxStore.setState({ ...EMPTY_SNAPSHOT, status: 'ready' })
    await act(async () => {
      await useNotificationInboxStore.getState().clearAll()
    })
    expect(bridge.clearAll).not.toHaveBeenCalled()
  })
})
