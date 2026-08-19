import { create } from 'zustand'

import type { NotificationInboxSnapshot } from '../../../shared/notifications'

type NotificationInboxStore = NotificationInboxSnapshot & {
  status: 'idle' | 'loading' | 'ready' | 'error'
  error?: string
  refresh: () => Promise<void>
  markRead: (ids: readonly string[]) => Promise<void>
  markAllRead: () => Promise<void>
  markSessionCompletionsRead: (sessionIds: readonly string[]) => Promise<void>
  listen: () => () => void
}

const EMPTY_SNAPSHOT: NotificationInboxSnapshot = {
  revision: 0,
  unreadCount: 0,
  latestSequence: 0,
  items: []
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : 'Messages could not be loaded.'

let refreshTail: Promise<void> = Promise.resolve()

// Mirrors the backend-owned snapshot. Every renderer subscribes before its first read, while the
// serialized refresh queue prevents an older RPC response from overwriting a newer event-triggered one.
export const useNotificationInboxStore = create<NotificationInboxStore>((set, get) => ({
  ...EMPTY_SNAPSHOT,
  status: 'idle',

  refresh: () => {
    const operation = async (): Promise<void> => {
      const api = window.api?.notifications
      if (!api?.getSnapshot) return
      if (get().status === 'idle') set({ status: 'loading', error: undefined })
      try {
        const snapshot = await api.getSnapshot()
        set({ ...snapshot, status: 'ready', error: undefined })
      } catch (error) {
        set({ status: 'error', error: errorMessage(error) })
      }
    }
    refreshTail = refreshTail.then(operation, operation)
    return refreshTail
  },

  markRead: async (ids) => {
    const normalized = [...new Set(ids.map((id) => id.trim()).filter(Boolean))]
    if (normalized.length === 0) return
    const mark = window.api?.notifications?.markRead
    if (!mark) return
    await mark({ ids: normalized })
    await get().refresh()
  },

  markAllRead: async () => {
    const throughSequence = get().latestSequence
    if (throughSequence <= 0 || get().unreadCount === 0) return
    const mark = window.api?.notifications?.markAllRead
    if (!mark) return
    await mark({ throughSequence })
    await get().refresh()
  },

  markSessionCompletionsRead: async (sessionIds) => {
    const normalized = [...new Set(sessionIds.map((id) => id.trim()).filter(Boolean))]
    if (normalized.length === 0) return
    const mark = window.api?.notifications?.markSessionCompletionsRead
    if (!mark) return
    await mark({ sessionIds: normalized })
    await get().refresh()
  },

  listen: () => {
    const api = window.api?.notifications
    if (!api?.onChanged || !api.getSnapshot) return () => undefined
    const refresh = (): void => void get().refresh()
    const remove = api.onChanged(refresh)
    window.addEventListener('purescience:web-events-open', refresh)
    // Web 恢复重放: 页面从后台恢复或网络恢复时重新拉取最新状态 — 补上连接中断期间
    // 错过的事件 (拉取式重放, 对齐上游 v0.15.1 web 事件恢复语义)。
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') refresh()
    }
    const onOnline = (): void => refresh()
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('online', onOnline)
    void get().refresh()
    return () => {
      remove()
      window.removeEventListener('purescience:web-events-open', refresh)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('online', onOnline)
    }
  }
}))

export { EMPTY_SNAPSHOT }
