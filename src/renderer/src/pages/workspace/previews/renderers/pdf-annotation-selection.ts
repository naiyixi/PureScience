import { isBookmarkRect, type BookmarkRect } from '../../../../../../shared/bookmark'

// Turning what the reader has SELECTED on a PDF page into an anchor, for 文档标注层 A3.
//
// Selection is the part of a highlight that cannot be checked by reading the code: it is geometry the
// browser computes, so the arithmetic and the reading are separated here and the reading is injectable.
// The default reads the window's own selection; a test drives the same code with a fabricated one, which
// is the only way to assert where a highlight lands without a real mouse and a real PDF.
//
// Normalized to the page box (0..1), exactly like a region bookmark and an imported selector, so a
// highlight drawn today still lands on the same words after a zoom, a resize or a DPI change.

export type PdfTextSelection = {
  /** The passage, as the reader sees it — the quote a highlight is anchored on. */
  quote: string
  /** One normalized rectangle per line the selection covers. */
  rects: BookmarkRect[]
}

// The smallest slice of the Selection/DOM APIs this module needs, declared structurally so a test can
// hand over a plain object instead of a jsdom Range.
export type SelectionRectLike = {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
}

export type SelectionRangeLike = {
  getClientRects: () => ArrayLike<SelectionRectLike>
}

export type SelectionLike = {
  toString: () => string
  rangeCount: number
  getRangeAt: (index: number) => SelectionRangeLike
}

export type SelectionReader = () => SelectionLike | null | undefined

// Four decimals, the same rounding a region bookmark and an imported selector use, so the three kinds of
// anchor stay directly comparable.
const round4 = (value: number): number => Math.round(value * 10_000) / 10_000

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value))

const defaultReader: SelectionReader = () =>
  typeof window === 'undefined' ? undefined : (window.getSelection?.() as SelectionLike | null)

// One line of the selection, in the page's own coordinates. A rect that only touches the page box edge
// (the browser reports a zero-width caret rect for some ranges) is dropped rather than stored as a
// rectangle with no extent.
const normalizeRect = (
  rect: SelectionRectLike,
  bounds: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>
): BookmarkRect | undefined => {
  const clippedLeft = Math.max(rect.left, bounds.left)
  const clippedTop = Math.max(rect.top, bounds.top)
  const clippedRight = Math.min(rect.right, bounds.left + bounds.width)
  const clippedBottom = Math.min(rect.bottom, bounds.top + bounds.height)
  if (!(clippedRight > clippedLeft) || !(clippedBottom > clippedTop)) return undefined
  const normalized: BookmarkRect = {
    x: round4(clamp01((clippedLeft - bounds.left) / bounds.width)),
    y: round4(clamp01((clippedTop - bounds.top) / bounds.height)),
    width: round4(clamp01((clippedRight - clippedLeft) / bounds.width)),
    height: round4(clamp01((clippedBottom - clippedTop) / bounds.height))
  }
  // The page box can clip a rectangle down to a sliver; `isBookmarkRect` is the same rule the store
  // applies, so a rectangle it would refuse never leaves this function.
  return isBookmarkRect(normalized) ? normalized : undefined
}

/**
 * Reads the current selection as an anchor for the page it was made on.
 *
 * Answers nothing when there is no selection, when it is empty, or when every rectangle it covers falls
 * outside this page — a highlight on no text is not stored, exactly as the import channel refuses a
 * markup that covers no text.
 */
export const readPdfPageSelection = (
  page: HTMLElement,
  read: SelectionReader = defaultReader
): PdfTextSelection | undefined => {
  const selection = read()
  if (!selection || selection.rangeCount <= 0) return undefined

  const quote = selection.toString().trim()
  if (!quote) return undefined

  const bounds = page.getBoundingClientRect()
  if (!(bounds.width > 0) || !(bounds.height > 0)) return undefined

  const rects: BookmarkRect[] = []
  for (let index = 0; index < selection.rangeCount; index += 1) {
    const range = selection.getRangeAt(index)
    const clientRects = range?.getClientRects?.()
    if (!clientRects) continue
    for (let rectIndex = 0; rectIndex < clientRects.length; rectIndex += 1) {
      const clientRect = clientRects[rectIndex]
      if (!clientRect) continue
      const normalized = normalizeRect(clientRect, bounds)
      if (normalized) rects.push(normalized)
    }
  }
  if (rects.length === 0) return undefined

  return { quote, rects }
}
