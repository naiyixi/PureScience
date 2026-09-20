// Session-bookmark persistence (v1.65 unit 2). One JSON file per session under .bookmarks/, written
// by the main process only (atomic temp-file + rename), the same spine the annotation store uses.
//
// The store is deliberately separate from every agent-facing surface: it is not registered as an MCP
// tool, it is not injected into prompts, and it takes no project id — a bookmark belongs to the
// session the researcher was reading, and to nobody else.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import {
  BOOKMARK_MAX_NOTE_LENGTH,
  isBookmarkRect,
  validateBookmarkInput,
  type SessionBookmark,
  type SessionBookmarkInput
} from '../../shared/bookmark'

const BOOKMARKS_DIR = '.bookmarks'

export class BookmarkValidationError extends Error {
  readonly code: NonNullable<ReturnType<typeof validateBookmarkInput>>['code']

  constructor(code: BookmarkValidationError['code'], message: string) {
    super(message)
    this.name = 'BookmarkValidationError'
    this.code = code
  }
}

export type BookmarkRepositoryOptions = {
  storageRoot: string
  createId?: () => string
  now?: () => number
}

const isSessionBookmark = (value: unknown): value is SessionBookmark => {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<SessionBookmark>
  if (typeof candidate.id !== 'string' || typeof candidate.sessionId !== 'string') return false
  if (typeof candidate.createdAt !== 'number' || typeof candidate.updatedAt !== 'number') {
    return false
  }
  const anchor = candidate.anchor
  if (typeof anchor !== 'object' || anchor === null) return false
  if (anchor.kind === 'message-text') {
    return typeof anchor.messageId === 'string' && typeof anchor.text === 'string'
  }
  if (anchor.kind === 'preview-text') return typeof anchor.text === 'string'
  if (anchor.kind === 'pdf-region') {
    return (
      Number.isInteger(anchor.page) &&
      isBookmarkRect(anchor.rect) &&
      (anchor.text === undefined || typeof anchor.text === 'string')
    )
  }
  return false
}

export class BookmarkRepository {
  private readonly createId: () => string
  private readonly now: () => number

  constructor(private readonly options: BookmarkRepositoryOptions) {
    this.createId = options.createId ?? (() => crypto.randomUUID())
    this.now = options.now ?? (() => Date.now())
  }

  private bookmarksPath(sessionId: string): string {
    return join(this.options.storageRoot, BOOKMARKS_DIR, `${encodeURIComponent(sessionId)}.json`)
  }

  async list(sessionId: string): Promise<SessionBookmark[]> {
    try {
      const raw = await readFile(this.bookmarksPath(sessionId), 'utf8')
      const parsed = JSON.parse(raw) as unknown
      if (!Array.isArray(parsed)) return []
      return parsed.filter(isSessionBookmark)
    } catch {
      // A missing or unreadable file means "no bookmarks yet", never an error the user must clear.
      return []
    }
  }

  async add(input: SessionBookmarkInput): Promise<SessionBookmark> {
    const failure = validateBookmarkInput(input)
    if (failure) throw new BookmarkValidationError(failure.code, failure.message)
    const bookmarks = await this.list(input.sessionId)
    const timestamp = this.now()
    const bookmark: SessionBookmark = {
      id: this.createId(),
      sessionId: input.sessionId,
      anchor: input.anchor,
      note: input.note?.trim() ? input.note.trim() : undefined,
      createdAt: timestamp,
      updatedAt: timestamp
    }
    await this.write(input.sessionId, [...bookmarks, bookmark])
    return bookmark
  }

  // Editing the note is the one mutation a saved bookmark needs; the anchor is what makes it worth
  // keeping, so it is never rewritten in place.
  async updateNote(
    sessionId: string,
    bookmarkId: string,
    note: string
  ): Promise<SessionBookmark | null> {
    // The note is validated before the lookup: an oversized note is refused whether or not the
    // bookmark exists, so the caller never sees "not found" for input that was invalid anyway.
    const trimmed = note.trim()
    if (trimmed.length > BOOKMARK_MAX_NOTE_LENGTH) {
      throw new BookmarkValidationError('invalid_note', 'The bookmark note is too long.')
    }
    const bookmarks = await this.list(sessionId)
    const index = bookmarks.findIndex((bookmark) => bookmark.id === bookmarkId)
    if (index < 0) return null
    const updated: SessionBookmark = {
      ...bookmarks[index],
      note: trimmed ? trimmed : undefined,
      updatedAt: this.now()
    }
    const next = [...bookmarks]
    next[index] = updated
    await this.write(sessionId, next)
    return updated
  }

  // Removing an already-missing bookmark is a no-op success, so the UI can retry safely.
  async remove(sessionId: string, bookmarkId: string): Promise<boolean> {
    const bookmarks = await this.list(sessionId)
    const next = bookmarks.filter((bookmark) => bookmark.id !== bookmarkId)
    if (next.length === bookmarks.length) return false
    await this.write(sessionId, next)
    return true
  }

  private async write(sessionId: string, bookmarks: SessionBookmark[]): Promise<void> {
    const target = this.bookmarksPath(sessionId)
    await mkdir(dirname(target), { recursive: true })
    const temp = `${target}.${this.createId()}.tmp`
    await writeFile(temp, JSON.stringify(bookmarks, null, 2), 'utf8')
    await rename(temp, target)
  }
}
