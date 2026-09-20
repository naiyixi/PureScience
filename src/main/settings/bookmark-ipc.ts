// Session-bookmark IPC handlers (v1.65 unit 2). The renderer's bookmark surface: list, save, rename
// the note, delete. Every mutation goes through the main-process repository (single writer), exactly
// like the annotation store — but unlike annotations there is no agent-facing counterpart, because a
// bookmark is the researcher's own reading trail and never belongs in a model context.

import { ipcMainHandle } from '../ipc-handler-registry'
import type { SessionBookmark, SessionBookmarkInput } from '../../shared/bookmark'
import type { BookmarkRepository } from './bookmark-repository'

export const BOOKMARK_IPC = {
  SET: 'bookmark:set',
  LIST: 'bookmark:list',
  REMOVE: 'bookmark:remove',
  UPDATE_NOTE: 'bookmark:update-note'
} as const

export type BookmarkCommandOwner = {
  set: (input: SessionBookmarkInput) => Promise<SessionBookmark>
  list: (sessionId: string) => Promise<SessionBookmark[]>
  remove: (sessionId: string, bookmarkId: string) => Promise<boolean>
  updateNote: (
    sessionId: string,
    bookmarkId: string,
    note: string
  ) => Promise<SessionBookmark | null>
}

export const createBookmarkCommandOwner = (
  repository: BookmarkRepository
): BookmarkCommandOwner => ({
  set: (input) => repository.add(input),
  list: (sessionId) => repository.list(sessionId),
  remove: (sessionId, bookmarkId) => repository.remove(sessionId, bookmarkId),
  updateNote: (sessionId, bookmarkId, note) => repository.updateNote(sessionId, bookmarkId, note)
})

export const registerBookmarkIpcHandlers = (owner: BookmarkCommandOwner): BookmarkCommandOwner => {
  ipcMainHandle(BOOKMARK_IPC.SET, (_event, input: SessionBookmarkInput) => owner.set(input))
  ipcMainHandle(BOOKMARK_IPC.LIST, (_event, sessionId: string) => owner.list(sessionId))
  ipcMainHandle(BOOKMARK_IPC.REMOVE, (_event, sessionId: string, bookmarkId: string) =>
    owner.remove(sessionId, bookmarkId)
  )
  ipcMainHandle(
    BOOKMARK_IPC.UPDATE_NOTE,
    (_event, sessionId: string, bookmarkId: string, note: string) =>
      owner.updateNote(sessionId, bookmarkId, note)
  )
  return owner
}
