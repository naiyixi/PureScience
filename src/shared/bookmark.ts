// Session bookmarks (v1.65 unit 2): a private, user-side note on something the researcher read —
// a message passage, a previewed passage, or a region of a PDF — that can be jumped back to later.
//
// Privacy is the defining property, not a setting: bookmarks live in their own store, are written
// only by the main process, and are exposed to the renderer only. There is deliberately no
// agent-facing tool for them (see BOOKMARK_AGENT_VISIBILITY), so nothing here can enter a model
// context. The UI says so next to the list, and a test pins it.

export const BOOKMARK_AGENT_VISIBILITY = 'user-only' as const

export const BOOKMARK_MAX_TEXT_LENGTH = 4000
export const BOOKMARK_MAX_NOTE_LENGTH = 4000

export type BookmarkAnchorKind = 'message-text' | 'preview-text' | 'pdf-region'

// Normalized page coordinates (0..1 of the page box), so a region survives zoom and DPI changes.
export type BookmarkRect = {
  x: number
  y: number
  width: number
  height: number
}

export type BookmarkAnchor =
  | { kind: 'message-text'; messageId: string; text: string }
  | {
      kind: 'preview-text'
      text: string
      // The exact artifact version the passage was read from; jumping back opens that version rather
      // than "the latest file with the same name".
      artifactVersionId?: string
      // The app's canonical pointer (project/session/artifact/version) to that same version, which is
      // what a jump needs to reopen it. Written together with `artifactVersionId`; a passage taken from
      // a source with no managed version behind it carries neither.
      locator?: string
      managedFileId?: string
    }
  | {
      kind: 'pdf-region'
      page: number
      rect: BookmarkRect
      text?: string
      artifactVersionId?: string
      // Same canonical pointer as a preview passage, for the same reason: a region drawn on version 2
      // must reopen version 2, and a bare version id cannot be resolved later.
      locator?: string
      managedFileId?: string
    }

export type SessionBookmark = {
  id: string
  sessionId: string
  anchor: BookmarkAnchor
  note?: string
  createdAt: number
  updatedAt: number
}

export type SessionBookmarkInput = {
  sessionId: string
  anchor: BookmarkAnchor
  note?: string
}

export type BookmarkValidationFailure = {
  code:
    | 'invalid_session'
    | 'invalid_anchor_kind'
    | 'invalid_text'
    | 'invalid_message_id'
    | 'invalid_page'
    | 'invalid_rect'
    | 'invalid_locator'
    | 'invalid_note'
  message: string
}

export const isBookmarkAnchorKind = (value: string): value is BookmarkAnchorKind =>
  value === 'message-text' || value === 'preview-text' || value === 'pdf-region'

const isFinite01 = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1

export const isBookmarkRect = (value: unknown): value is BookmarkRect => {
  if (typeof value !== 'object' || value === null) return false
  const rect = value as Partial<BookmarkRect>
  return (
    isFinite01(rect.x) &&
    isFinite01(rect.y) &&
    isFinite01(rect.width) &&
    isFinite01(rect.height) &&
    rect.width > 0 &&
    rect.height > 0
  )
}

// Pure validation shared by the repository and the renderer, so the same rules are applied on both
// sides of the boundary and a rejected bookmark carries a named reason.
export const validateBookmarkInput = (
  input: SessionBookmarkInput
): BookmarkValidationFailure | undefined => {
  if (typeof input.sessionId !== 'string' || !input.sessionId.trim()) {
    return { code: 'invalid_session', message: 'A bookmark belongs to exactly one session.' }
  }
  const anchor = input.anchor
  if (!anchor || typeof anchor !== 'object') {
    return { code: 'invalid_anchor_kind', message: 'A bookmark needs an anchor.' }
  }
  if (anchor.kind === 'message-text') {
    if (!anchor.messageId?.trim()) {
      return { code: 'invalid_message_id', message: 'A message bookmark needs its message id.' }
    }
    if (!anchor.text?.trim()) {
      return { code: 'invalid_text', message: 'A message bookmark needs the passage it points at.' }
    }
  } else if (anchor.kind === 'preview-text') {
    if (!anchor.text?.trim()) {
      return { code: 'invalid_text', message: 'A preview bookmark needs the passage it points at.' }
    }
    // A half-written pointer is refused rather than stored: a jump that cannot resolve must not look
    // like a jump that works.
    if (anchor.locator !== undefined && anchor.locator.trim() === '') {
      return {
        code: 'invalid_locator',
        message: 'A preview bookmark locator must point somewhere.'
      }
    }
  } else if (anchor.kind === 'pdf-region') {
    if (!Number.isInteger(anchor.page) || anchor.page < 1) {
      return { code: 'invalid_page', message: 'A PDF bookmark needs a 1-based page number.' }
    }
    if (anchor.locator !== undefined && anchor.locator.trim() === '') {
      return { code: 'invalid_locator', message: 'A PDF bookmark locator must point somewhere.' }
    }
    if (!isBookmarkRect(anchor.rect)) {
      return {
        code: 'invalid_rect',
        message: 'A PDF region is four normalized numbers (0..1) with a non-zero size.'
      }
    }
  } else {
    return { code: 'invalid_anchor_kind', message: `Unknown bookmark anchor kind.` }
  }

  const text = anchor.kind === 'pdf-region' ? (anchor.text ?? '') : anchor.text
  if (text.length > BOOKMARK_MAX_TEXT_LENGTH) {
    return { code: 'invalid_text', message: 'The bookmarked passage is too long.' }
  }
  if ((input.note?.length ?? 0) > BOOKMARK_MAX_NOTE_LENGTH) {
    return { code: 'invalid_note', message: 'The bookmark note is too long.' }
  }
  return undefined
}

// What a bookmark can be attached to when it is cited as evidence: the review surface reads this, so
// a bookmark stays traceable to the artifact version it was taken from (and to nothing when it was
// taken from a conversation passage).
export const bookmarkEvidenceTarget = (
  bookmark: SessionBookmark
): { artifactVersionId?: string; managedFileId?: string } => {
  const anchor = bookmark.anchor
  if (anchor.kind === 'message-text') return {}
  return { artifactVersionId: anchor.artifactVersionId, managedFileId: anchor.managedFileId }
}
