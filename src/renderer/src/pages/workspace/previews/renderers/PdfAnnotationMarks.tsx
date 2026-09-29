import type { PdfAnnotationMark } from './pdf-annotation-marks'

// The markup of the version on screen, painted over the page it was drawn on (文档标注层 A3).
//
// Drawn ABOVE the canvas and BELOW the text layer, and with pointer events off: a mark must never take a
// click meant for the text under it, or the reader could no longer select the passage they wanted to
// highlight. Positions are the normalized 0..1 rectangles the anchor stores, so a mark survives zoom, a
// resize and a DPI change without being recomputed from the canvas.

// Four decimals of a page box is finer than any display resolves; the same rounding the anchor uses.
const percent = (value: number): string => `${(value * 100).toFixed(4)}%`

const boxStyle = (mark: PdfAnnotationMark): React.CSSProperties => ({
  left: percent(mark.rect.x),
  top: percent(mark.rect.y),
  width: percent(mark.rect.width),
  height: percent(mark.rect.height)
})

const KIND_CLASS: Readonly<Record<PdfAnnotationMark['kind'], string>> = {
  highlight: 'bg-amber-400/35',
  underline: 'border-b-2 border-amber-500/80',
  squiggly: 'border-b-2 border-dashed border-indigo-500/80',
  strikethrough: 'border-b-2 border-rose-500/70',
  area: 'border border-sky-500/80 bg-sky-400/10',
  'page-note': 'border border-amber-500/80 bg-amber-300/40',
  'document-note': 'hidden'
}

export const PdfAnnotationMarks = ({
  marks
}: {
  marks: readonly PdfAnnotationMark[]
}): React.JSX.Element | null => {
  if (marks.length === 0) return null

  return (
    // Positioned but with no z-index, and earlier in the DOM than the selectable text layer: the marks
    // paint over the canvas and UNDER the text, so the browser still draws its selection highlight above
    // them and a passage stays readable while it is being selected.
    <div data-slot="pdf-annotation-marks" className="pointer-events-none absolute inset-0">
      {marks.map((mark, index) => (
        <span
          key={`${mark.annotationId}-${index}`}
          data-slot="pdf-annotation-mark"
          data-kind={mark.kind}
          data-annotation-id={mark.annotationId}
          aria-hidden="true"
          className={`absolute ${KIND_CLASS[mark.kind]}`}
          style={boxStyle(mark)}
        >
          {/* A strike-through is a line through the passage, which a bottom border is not: it is drawn in
              the middle of the rectangle the markup covers. */}
          {mark.kind === 'strikethrough' ? (
            <span className="absolute inset-x-0 top-1/2 border-t-2 border-rose-500/70" />
          ) : null}
        </span>
      ))}
    </div>
  )
}
