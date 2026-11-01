import { create } from 'zustand'

import type {
  NotificationInboxChanged,
  NotificationInboxSnapshot
} from '../../../shared/notifications'

type NotificationInboxStore = NotificationInboxSnapshot & {
  status: 'idle' | 'loading' | 'ready' | 'error'
  error?: string
  /** Immediate read. Used where the reader just asked for the rows (first subscribe, opening the panel). */
  refresh: () => Promise<void>
  /**
   * The same read, merged: several requests inside one tick collapse into a single `getSnapshot`. The
   * change feed and the mutations below use this one — a burst of events (a task finished, then its
   * authorization settled) is one read, not one per event.
   */
  requestRefresh: () => Promise<void>
  markRead: (ids: readonly string[]) => Promise<void>
  markAllRead: () => Promise<void>
  markSessionCompletionsRead: (sessionIds: readonly string[]) => Promise<void>
  deleteItems: (ids: readonly string[]) => Promise<void>
  clearAll: () => Promise<void>
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
export const useNotificationInboxStore = create<NotificationInboxStore>((set, get) => {
  // One pending merged read at a time. The merge boundary is a macro-task, not a micro-task: React resumes
  // a suspended render inside a promise continuation, so merging there would land a store write in the
  // middle of one — the same reason the runtime broadcast path merges on a timer.
  let queued: ReturnType<typeof setTimeout> | undefined
  let queuedRead: Promise<void> | undefined
  let settleQueued: (() => void) | undefined

  const read = async (): Promise<void> => {
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

  const enqueueRead = (): Promise<void> => {
    refreshTail = refreshTail.then(read, read)
    return refreshTail
  }

  return {
    ...EMPTY_SNAPSHOT,
    status: 'idle',

    refresh: () => enqueueRead(),

    requestRefresh: () => {
      if (queuedRead) return queuedRead
      queuedRead = new Promise<void>((resolve) => {
        settleQueued = resolve
      })
      queued = setTimeout(() => {
        queued = undefined
        const settle = settleQueued
        settleQueued = undefined
        void enqueueRead().finally(() => {
          queuedRead = undefined
          settle?.()
        })
      }, 0)
      return queuedRead
    },

    markRead: async (ids) => {
      const normalized = [...new Set(ids.map((id) => id.trim()).filter(Boolean))]
      if (normalized.length === 0) return
      const mark = window.api?.notifications?.markRead
      if (!mark) return
      await mark({ ids: normalized })
      await get().requestRefresh()
    },

    markAllRead: async () => {
      const throughSequence = get().latestSequence
      if (throughSequence <= 0 || get().unreadCount === 0) return
      const mark = window.api?.notifications?.markAllRead
      if (!mark) return
      await mark({ throughSequence })
      await get().requestRefresh()
    },

    markSessionCompletionsRead: async (sessionIds) => {
      const normalized = [...new Set(sessionIds.map((id) => id.trim()).filter(Boolean))]
      if (normalized.length === 0) return
      const mark = window.api?.notifications?.markSessionCompletionsRead
      if (!mark) return
      await mark({ sessionIds: normalized })
      await get().requestRefresh()
    },

    // Deleting a card never deletes what it points at. A refused deletion must not look like a silent
    // no-op, so the failure lands in the panel's existing error state instead of an unhandled rejection.
    deleteItems: async (ids) => {
      const normalized = [...new Set(ids.map((id) => id.trim()).filter(Boolean))]
      if (normalized.length === 0) return
      const remove = window.api?.notifications?.deleteItems
      if (!remove) return
      try {
        await remove({ ids: normalized })
      } catch (error) {
        set({ status: 'error', error: errorMessage(error) })
        return
      }
      await get().requestRefresh()
    },

    // Bound to the sequence on screen when the action is confirmed, so a notice that arrives afterwards
    // survives the sweep (the same boundary `markAllRead` uses).
    clearAll: async () => {
      const throughSequence = get().latestSequence
      if (throughSequence <= 0 || get().items.length === 0) return
      const clear = window.api?.notifications?.clearAll
      if (!clear) return
      try {
        await clear({ throughSequence })
      } catch (error) {
        set({ status: 'error', error: errorMessage(error) })
        return
      }
      await get().requestRefresh()
    },

    listen: () => {
      const api = window.api?.notifications
      if (!api?.onChanged || !api.getSnapshot) return () => undefined
      // The event already carries the two numbers the bell renders, and its revision identifies the state it
      // describes. Reading the whole list on every frame spends main-process time on rows nobody asked to
      // see — a 600-row snapshot measured 425 ms on the device, and this app's own log lists
      // `notifications:get-snapshot` among its slowest channels (30 calls over three days, median 879 ms).
      // So: paint the badge from the payload, skip a revision already on screen, and read the rows once per
      // burst. Note what this deliberately does NOT do — it never invents a count: a payload without the
      // numbers falls through to a read, and the read stays the authority for the rows.
      const onChanged = (change?: NotificationInboxChanged): void => {
        const state = get()
        const revision = typeof change?.revision === 'number' ? change.revision : undefined
        if (revision !== undefined) {
          if (state.status === 'ready' && revision <= state.revision) return
          const patch: { unreadCount?: number; latestSequence?: number } = {}
          const unreadCount = change?.unreadCount
          if (typeof unreadCount === 'number' && Number.isFinite(unreadCount)) {
            if (unreadCount !== state.unreadCount) patch.unreadCount = unreadCount
          }
          const latestSequence = change?.latestSequence
          if (typeof latestSequence === 'number' && Number.isFinite(latestSequence)) {
            if (latestSequence !== state.latestSequence) patch.latestSequence = latestSequence
          }
          // Only a real difference is written: a state object rebuilt for identical numbers would
          // re-render every subscriber (including the panel that lists all rows) for nothing.
          if (Object.keys(patch).length > 0) set(patch)
        }
        void get().requestRefresh()
      }
      const refresh = (): void => void get().requestRefresh()
      const remove = api.onChanged(onChanged)
      window.addEventListener('purescience:web-events-open', refresh)
      // Web 恢复重放: 页面从后台恢复或网络恢复时重新拉取最新状态 — 补上连接中断期间
      // 错过的事件 (拉取式重放, 对齐行业实践 web 事件恢复语义)。
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
        if (queued !== undefined) {
          clearTimeout(queued)
          queued = undefined
        }
        const settle = settleQueued
        settleQueued = undefined
        queuedRead = undefined
        settle?.()
      }
    }
  }
})

export { EMPTY_SNAPSHOT }
