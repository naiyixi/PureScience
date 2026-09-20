import { useCallback, useEffect, useState } from 'react'
import { Bookmark, ChevronRight, Trash2, X } from 'lucide-react'

import { useLanguage } from '@/i18n'
import { useNavigationStore } from '@/stores/navigation-store'
import type { SessionBookmark } from '../../../../shared/bookmark'

// Session bookmarks (v1.65 unit 2): the reader's private trail through this conversation. Nothing
// here is sent to the agent, and the panel says so — the promise is a visible part of the surface,
// not a footnote in a document nobody opens.
//
// Jumping back uses the same message scroller the command palette uses, so a bookmark lands exactly
// where the passage lives rather than approximating with a page offset.

const excerpt = (text: string, limit = 160): string =>
  text.length > limit ? `${text.slice(0, limit)}…` : text

export function SessionBookmarksDialog({
  open,
  onClose,
  sessionId,
  onOpenVersionPreview
}: {
  open: boolean
  onClose: () => void
  sessionId: string | undefined
  // A passage taken from a preview is reopened where it was read: the workspace owns previews, so the
  // dialog hands the pointer over instead of trying to open one itself.
  onOpenVersionPreview?: (locator: string) => void
}): React.JSX.Element | null {
  const { t } = useLanguage()
  const requestMessageFocus = useNavigationStore((state) => state.requestMessageFocus)
  const [bookmarks, setBookmarks] = useState<SessionBookmark[]>([])
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | undefined>(undefined)

  const load = useCallback(async (): Promise<void> => {
    if (!sessionId) return
    try {
      const listed = await window.api.bookmark.list(sessionId)
      setBookmarks(listed)
      setNoteDrafts(
        Object.fromEntries(listed.map((bookmark) => [bookmark.id, bookmark.note ?? '']))
      )
      setError(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [sessionId])

  // Loading follows the same shape the other private surfaces use: the effect starts the read and the
  // state lands in its continuation, and a result that arrives after teardown is dropped.
  useEffect(() => {
    if (!open || !sessionId) return
    let alive = true
    void window.api.bookmark
      .list(sessionId)
      .then((listed) => {
        if (!alive) return
        setBookmarks(listed)
        setNoteDrafts(
          Object.fromEntries(listed.map((bookmark) => [bookmark.id, bookmark.note ?? '']))
        )
        setError(undefined)
      })
      .catch((cause: unknown) => {
        if (!alive) return
        setError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      alive = false
    }
  }, [open, sessionId])

  if (!open) return null

  const kindLabel = (bookmark: SessionBookmark): string => {
    switch (bookmark.anchor.kind) {
      case 'message-text':
        return t('bookmarks.kind.message')
      case 'preview-text':
        return t('bookmarks.kind.preview')
      default:
        return t('bookmarks.kind.pdfRegion')
    }
  }

  const anchorText = (bookmark: SessionBookmark): string => {
    const anchor = bookmark.anchor
    if (anchor.kind === 'pdf-region') return anchor.text ?? `p.${anchor.page}`
    return anchor.text
  }

  // Jumping back asks the workspace for the focus, the same way a search hit does: this dialog lives
  // outside the message scroller, so it must not pretend to own the scroll.
  const handleJump = (bookmark: SessionBookmark): void => {
    if (!sessionId) return
    const anchor = bookmark.anchor
    if (anchor.kind === 'message-text') {
      requestMessageFocus({ sessionId, messageId: anchor.messageId })
      onClose()
      return
    }
    // A region and a passage reopen the same way: the version they were taken from.
    if ((anchor.kind === 'preview-text' || anchor.kind === 'pdf-region') && anchor.locator) {
      onOpenVersionPreview?.(anchor.locator)
      onClose()
    }
  }

  const handleSaveNote = async (bookmark: SessionBookmark): Promise<void> => {
    if (!sessionId) return
    try {
      await window.api.bookmark.updateNote(sessionId, bookmark.id, noteDrafts[bookmark.id] ?? '')
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const handleRemove = async (bookmark: SessionBookmark): Promise<void> => {
    if (!sessionId) return
    try {
      await window.api.bookmark.remove(sessionId, bookmark.id)
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div
        role="dialog"
        aria-label={t('bookmarks.title')}
        data-slot="session-bookmarks-dialog"
        className="flex max-h-[70vh] w-[min(640px,92vw)] flex-col rounded-xl border border-[var(--border)] bg-[var(--card)] shadow-xl"
      >
        <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-2">
          <span className="flex items-center gap-2 text-sm font-medium text-[var(--foreground)]">
            <Bookmark className="size-4" aria-hidden="true" /> {t('bookmarks.title')}
          </span>
          <button type="button" aria-label={t('references.close')} onClick={onClose}>
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>
        <p className="border-b border-[var(--border)] px-4 py-1.5 text-[10px] text-[var(--muted-foreground)]">
          {t('bookmarks.privacy')}
        </p>
        {error ? (
          <p className="px-4 py-2 text-xs text-red-400" role="alert">
            {error}
          </p>
        ) : null}
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {bookmarks.length === 0 ? (
            <p className="py-8 text-center text-xs text-[var(--muted-foreground)]">
              {t('bookmarks.empty')}
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {bookmarks.map((bookmark) => (
                <li
                  key={bookmark.id}
                  className="rounded-lg border border-[var(--border)] px-3 py-2 text-xs"
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-[10px] text-[var(--muted-foreground)]">
                      {kindLabel(bookmark)}
                    </span>
                    <div className="flex items-center gap-1">
                      {bookmark.anchor.kind === 'message-text' ||
                      anchorText(bookmark).length === 0 ||
                      Boolean(
                        (bookmark.anchor.kind === 'preview-text' ||
                          bookmark.anchor.kind === 'pdf-region') &&
                        bookmark.anchor.locator
                      ) ? (
                        <button
                          type="button"
                          className="flex items-center gap-1 text-[10px] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                          onClick={() => handleJump(bookmark)}
                        >
                          {t('bookmarks.jump')}
                          <ChevronRight className="size-3" aria-hidden="true" />
                        </button>
                      ) : null}
                      <button
                        type="button"
                        aria-label={t('bookmarks.remove')}
                        onClick={() => void handleRemove(bookmark)}
                      >
                        <Trash2 className="size-3.5" aria-hidden="true" />
                      </button>
                    </div>
                  </div>
                  <p className="mt-1 whitespace-pre-wrap text-[var(--foreground)]">
                    {excerpt(anchorText(bookmark))}
                  </p>
                  <div className="mt-2 flex items-center gap-2">
                    <input
                      className="min-w-0 flex-1 rounded border border-[var(--border)] bg-transparent px-2 py-1 text-[11px]"
                      placeholder={t('bookmarks.notePlaceholder')}
                      aria-label={t('bookmarks.notePlaceholder')}
                      value={noteDrafts[bookmark.id] ?? ''}
                      onChange={(event) =>
                        setNoteDrafts((current) => ({
                          ...current,
                          [bookmark.id]: event.target.value
                        }))
                      }
                    />
                    <button
                      type="button"
                      className="rounded border border-[var(--border)] px-2 py-1 text-[10px]"
                      onClick={() => void handleSaveNote(bookmark)}
                    >
                      {t('bookmarks.saveNote')}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}
