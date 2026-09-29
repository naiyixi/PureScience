import type { BookmarkRect } from '../../../../../../shared/bookmark'
import type { PdfAnnotationView } from '../../../../../../shared/pdf-annotation-surface'
import type { PdfAnnotationKind } from '../../../../../../shared/pdf-annotations'

// What the page draws over itself (文档标注层 A3): the stored markup of the version on screen.
//
// ONE rule decides what is drawn, and it is the rule this whole slice exists for: only an annotation
// whose anchor state is `current` is drawn on these bytes. Markup of another version is listed in the
// panel with its named state, but never painted over a page it was not drawn on — drawing it would be a
// silent migration performed by the renderer, which is exactly what the anchor rule forbids.

export type PdfAnnotationMark = {
  annotationId: string
  kind: PdfAnnotationKind
  page: number
  rect: BookmarkRect
}

const isRect = (value: unknown): value is BookmarkRect =>
  typeof value === 'object' && value !== null && 'width' in value

// The rectangles one annotation covers, in the selector shapes that have any: a text range has one per
// line, an area and a placed note have one, and a document note has none (it belongs to no page).
export const markRectsOf = (annotation: PdfAnnotationView['annotation']): BookmarkRect[] => {
  const selector = annotation.selector as unknown as Record<string, unknown>
  if (selector.shape === 'text-range') {
    const rects = Array.isArray(selector.rects) ? selector.rects : []
    return rects.filter(isRect)
  }
  if (selector.shape === 'area') {
    return isRect(selector.rect) ? [selector.rect] : []
  }
  if (selector.shape === 'page-note') {
    return isRect(selector.anchorRect) ? [selector.anchorRect] : []
  }
  return []
}

export const pdfAnnotationMarks = (
  annotations: readonly PdfAnnotationView[]
): PdfAnnotationMark[] =>
  annotations.flatMap(({ annotation, anchorState }) => {
    if (anchorState !== 'current') return []
    const selector = annotation.selector as unknown as Record<string, unknown>
    const page = typeof selector.page === 'number' ? selector.page : 0
    if (page < 1) return []
    return markRectsOf(annotation).map((rect) => ({
      annotationId: annotation.id,
      kind: annotation.kind,
      page,
      rect
    }))
  })
