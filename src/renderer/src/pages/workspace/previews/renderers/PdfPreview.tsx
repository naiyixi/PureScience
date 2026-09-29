import {
  Highlighter,
  List,
  Maximize2,
  SquareDashed,
  StickyNote,
  Underline,
  ZoomIn,
  ZoomOut
} from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useLanguage, type TranslationKey } from '@/i18n'
import { cn } from '@/lib/utils'
import type { PreviewFileSource } from '@/stores/preview-workbench-store'
import type { BookmarkRect } from '../../../../../../shared/bookmark'
import type {
  PdfAnnotationAnchorCounts,
  PdfAnnotationAnchorRequest,
  PdfAnnotationExportRequest,
  PdfAnnotationListResult
} from '../../../../../../shared/pdf-annotation-surface'
import type { PdfAnnotationExportChannel } from '../../../../../../shared/pdf-annotation-export'
import { resolveBookmarkVersionIdentity } from '../../bookmark-version-identity'

import { PdfAnnotationMarks } from './PdfAnnotationMarks'
import {
  PdfAnnotationPanel,
  type PdfAnnotationExportView,
  type PdfAnnotationImportView
} from './PdfAnnotationPanel'
import {
  pdfAnnotationAreaSelector,
  pdfAnnotationNoteAnchor,
  pdfAnnotationPageNoteSelector,
  pdfAnnotationTextRangeSelector
} from './pdf-annotation-content'
import { pdfAnnotationMarks, type PdfAnnotationMark } from './pdf-annotation-marks'
import { readPdfPageSelection, type PdfTextSelection } from './pdf-annotation-selection'

import { PreviewErrorCard, PreviewLoadingContent } from '../PreviewFallback'
import { createManagedPdfLoadingTask } from '../managed-pdf-document'
import { isUnavailableFileError } from '../preview-errors'
import { createPreviewResourceKey } from '../preview-resource-key'
import { releaseQuietly } from '../preview-resource-release'
import { createPreviewRequestScope } from '../preview-file-reader'
import type { PreviewFileRendererProps } from '../preview-types'
import { useNearViewport } from '../useNearViewport'
import { PdfRegionOverlay } from './PdfRegionOverlay'

type PdfDocument = Awaited<ReturnType<typeof createManagedPdfLoadingTask>['promise']>
type DocumentState =
  | { requestKey: string; status: 'ready'; document: PdfDocument }
  | { requestKey: string; status: 'error'; error: unknown }

// A text-layer span placed by pdf.js textContent geometry. The layer sits exactly on top of the
// page canvas and makes the rendered text selectable, so the workspace SelectionAnnotator can pick
// a passage as evidence and the source locator knows which page it came from.
type TextSpan = {
  text: string
  left: number
  top: number
  fontSize: number
  lineHeight: number
}

// The marking modes the annotation toolbar offers (文档标注层 A3), in reading order: the two text
// markups, then a region, then a note. Each one carries its own copy key, so the toolbar renders no
// hard-coded word of its own.
type PdfAnnotationGestureMode = 'highlight' | 'underline' | 'area' | 'page-note'

const ANNOTATION_MODES: readonly {
  mode: PdfAnnotationGestureMode
  labelKey: TranslationKey
  Icon: typeof Highlighter
}[] = [
  { mode: 'highlight', labelKey: 'pdfAnnotation.mode.highlight', Icon: Highlighter },
  { mode: 'underline', labelKey: 'pdfAnnotation.mode.underline', Icon: Underline },
  { mode: 'area', labelKey: 'pdfAnnotation.mode.area', Icon: SquareDashed },
  { mode: 'page-note', labelKey: 'pdfAnnotation.mode.pageNote', Icon: StickyNote }
]

// What the reader has to do next, named for whichever gesture is armed.
const ANNOTATION_HINT_KEYS: Readonly<
  Record<'bookmark-region' | PdfAnnotationGestureMode, TranslationKey>
> = {
  'bookmark-region': 'pdfRegion.mode',
  highlight: 'pdfAnnotation.hint.highlight',
  underline: 'pdfAnnotation.hint.underline',
  area: 'pdfAnnotation.hint.area',
  'page-note': 'pdfAnnotation.hint.pageNote'
}

// Comfortable reading width a page fills at 100%; zoom scales the displayed page beyond it.
const FIT_PAGE_WIDTH = 768
const MIN_ZOOM = 0.5
const MAX_ZOOM = 3
const ZOOM_BUTTON_STEP = 0.25
// Wheel zoom is proportional to accumulated deltaY so one trackpad/pinch gesture (many small
// events) maps to a controlled amount rather than a full step per event. ~100px notch ≈ 0.25.
const ZOOM_WHEEL_SENSITIVITY = 0.0025

const clampZoom = (zoom: number): number => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom))

// Bottom-right overlay mirroring the image preview's zoom affordances for a consistent feel.
const PdfZoomControls = ({
  zoom,
  onZoomIn,
  onZoomOut,
  onReset
}: {
  zoom: number
  onZoomIn: () => void
  onZoomOut: () => void
  onReset: () => void
}): React.JSX.Element => {
  const actions = [
    { label: 'Zoom out', icon: ZoomOut, onClick: onZoomOut, disabled: zoom <= MIN_ZOOM },
    { label: 'Reset zoom', icon: Maximize2, onClick: onReset, disabled: zoom === 1 },
    { label: 'Zoom in', icon: ZoomIn, onClick: onZoomIn, disabled: zoom >= MAX_ZOOM }
  ]

  return (
    <TooltipProvider delayDuration={300}>
      <div className="absolute bottom-3 right-3 z-10 flex items-center gap-1 rounded-md border border-border-300/50 bg-bg-000/90 p-1 shadow-sm backdrop-blur">
        <span className="min-w-[3ch] px-1 text-center text-[11px] tabular-nums text-text-200">
          {Math.round(zoom * 100)}%
        </span>
        {actions.map(({ label, icon: Icon, onClick, disabled }) => (
          <Tooltip key={label}>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="text-text-100 hover:text-text-000"
                aria-label={label}
                disabled={disabled}
                onClick={onClick}
              >
                <Icon aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{label}</TooltipContent>
          </Tooltip>
        ))}
      </div>
    </TooltipProvider>
  )
}
// Keep the backing store within browser canvas limits so a tall/narrow or heavily zoomed page
// cannot render blank: clamp each side and the total area (Chromium caps a dimension at 16384 and
// area near 2^28).
const MAX_CANVAS_DIMENSION = 8192
const MAX_CANVAS_AREA = 16 * 1024 * 1024
// Per-page backing-scale ceiling. Set above the ~4.5 that a full-width page needs at 175% zoom on
// a 2x display, so normal zoom stays crisp, while capping the deepest zoom so a few near-viewport
// pages cannot each allocate the full canvas-area budget and spike renderer memory.
const MAX_RENDER_SCALE = 5

// PDF.js rejects an in-flight render with this when cancel() is called; it is an expected teardown,
// not a page failure, so scroll-out, preview switches, and resize rerenders must not surface it.
const isRenderCancel = (error: unknown): boolean =>
  error instanceof Error && error.name === 'RenderingCancelledException'

// Owns one lazy page canvas and releases its decoded bitmap outside the overscan window.
const PdfPageCanvas = ({
  document,
  pageNumber,
  pageWidth,
  documentName,
  registerDisposer,
  regionMode = false,
  onRegion,
  onPagePress,
  textMarkKind,
  onTextMark,
  marks
}: {
  document: PdfDocument
  pageNumber: number
  pageWidth: number
  documentName: string
  registerDisposer: (dispose: () => void) => () => void
  regionMode?: boolean
  onRegion?: (page: number, rect: BookmarkRect) => void
  onPagePress?: (page: number, point: { x: number; y: number }) => void
  /** Set while the reader is marking text: which kind a selection becomes. */
  textMarkKind?: 'highlight' | 'underline'
  onTextMark?: (page: number, kind: 'highlight' | 'underline', selection: PdfTextSelection) => void
  /** The stored markup of the version on screen, already filtered to this page. */
  marks?: readonly PdfAnnotationMark[]
}): React.JSX.Element => {
  const [setNearViewportRef, isNearViewport] = useNearViewport<HTMLDivElement>()
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const pageRef = useRef<Awaited<ReturnType<PdfDocument['getPage']>> | undefined>(undefined)
  const renderTaskRef = useRef<
    ReturnType<Awaited<ReturnType<PdfDocument['getPage']>>['render']> | undefined
  >(undefined)
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [aspectRatio, setAspectRatio] = useState(3 / 4)
  // Bumped when a fresh page proxy is acquired so rasterization re-runs against the new page.
  const [pageEpoch, setPageEpoch] = useState(0)
  // Selectable text spans for the evidence annotator, keyed by the pageWidth they were laid out
  // at (text layer geometry is relative to the base viewport, scaled to the current page width).
  const [textSpans, setTextSpans] = useState<TextSpan[] | undefined>(undefined)

  // Acquire the page once while it is near the viewport and keep it alive; width changes then
  // re-rasterize this same page rather than reloading it through the range transport.
  useEffect(() => {
    if (!isNearViewport) return

    let canceled = false
    let disposed = false
    // Clear canvas backing storage on exit; removing the DOM node alone may retain its bitmap.
    const dispose = (): void => {
      if (disposed) return
      disposed = true
      canceled = true
      renderTaskRef.current?.cancel()
      renderTaskRef.current = undefined
      pageRef.current?.cleanup()
      pageRef.current = undefined
      const canvas = canvasRef.current
      if (canvas) {
        canvas.width = 0
        canvas.height = 0
      }
    }
    const unregisterDisposer = registerDisposer(dispose)

    void document
      .getPage(pageNumber)
      .then((acquiredPage) => {
        if (canceled) {
          acquiredPage.cleanup()
          return
        }
        pageRef.current = acquiredPage
        setPageEpoch((epoch) => epoch + 1)
      })
      .catch((error: unknown) => {
        if (!canceled) {
          console.error(`Failed to load PDF page ${pageNumber}`, error)
          setStatus('error')
        }
      })

    return () => {
      unregisterDisposer()
      dispose()
    }
  }, [document, isNearViewport, pageNumber, registerDisposer])

  // Rasterize the live page at the target width; re-runs on width change without reacquiring it.
  // Tied to isNearViewport so a scroll-out flips this effect's canceled flag and stops a rerender.
  useEffect(() => {
    const page = pageRef.current
    const canvas = canvasRef.current
    if (!isNearViewport || !page || !canvas) return

    let canceled = false
    const draw = async (): Promise<void> => {
      // Serialize against the previous render: PDF.js forbids two renders on one canvas, and its
      // cancel() settles asynchronously, so a resize-driven rerun must await the prior task first.
      const previous = renderTaskRef.current
      if (previous) {
        previous.cancel()
        await previous.promise.catch(() => undefined)
      }
      // The await above yields, during which the page can scroll out and dispose() can clear it;
      // bail before touching a disposed page or detached canvas.
      if (canceled || pageRef.current !== page) return

      const devicePixelRatio = Math.max(1, window.devicePixelRatio || 1)
      const baseViewport = page.getViewport({ scale: 1 })
      // Rasterize at the physical pixels the page occupies on screen (never below intrinsic size)
      // so zoom stays crisp at any DPI, capped by MAX_RENDER_SCALE so the deepest zoom cannot
      // allocate the full canvas budget per page.
      const targetCssWidth = pageWidth > 0 ? pageWidth : baseViewport.width
      const desiredScale = Math.max(
        1,
        Math.min(MAX_RENDER_SCALE, (targetCssWidth * devicePixelRatio) / baseViewport.width)
      )
      // Hard cap so neither backing dimension nor total area exceeds browser canvas limits — must
      // win over the intrinsic floor, or a page taller than the limit at scale 1 renders blank.
      const limitScale = Math.min(
        MAX_CANVAS_DIMENSION / baseViewport.width,
        MAX_CANVAS_DIMENSION / baseViewport.height,
        Math.sqrt(MAX_CANVAS_AREA / (baseViewport.width * baseViewport.height))
      )
      const scale = Math.min(desiredScale, limitScale)
      const viewport = page.getViewport({ scale })
      const context = canvas.getContext('2d')
      if (!context) throw new Error('Canvas 2D context unavailable.')

      // Match the actual PDF page geometry so landscape and non-standard pages are not stretched.
      setAspectRatio(viewport.width / viewport.height)
      canvas.width = viewport.width
      canvas.height = viewport.height
      const renderTask = page.render({ canvas, canvasContext: context, viewport })
      renderTaskRef.current = renderTask
      await renderTask.promise
      if (renderTaskRef.current === renderTask) renderTaskRef.current = undefined
      if (!canceled) setStatus('ready')
    }

    void draw().catch((error: unknown) => {
      // A canceled render (scroll-out, preview switch, or superseding resize) is expected teardown.
      if (canceled || isRenderCancel(error)) return
      console.error(`Failed to render PDF page ${pageNumber}`, error)
      setStatus('error')
    })

    return () => {
      canceled = true
      renderTaskRef.current?.cancel()
    }
  }, [isNearViewport, pageEpoch, pageNumber, pageWidth])

  const displayedStatus = isNearViewport ? status : 'idle'

  // Lay out the selectable text layer at the current page width. pdf.js textContent items carry
  // base-viewport geometry (transform: 1x1 units); scale positions/fonts by the same ratio the
  // canvas rasterization uses so spans land exactly on the rendered glyphs. Empty (scanned) pages
  // produce no items and stay canvas-only, which keeps selection unavailable for non-text PDFs.
  useEffect(() => {
    const page = pageRef.current
    if (!isNearViewport || !page || pageWidth <= 0) return
    let canceled = false

    void page
      .getTextContent()
      .then((content) => {
        if (canceled) return
        const baseViewport = page.getViewport({ scale: 1 })
        const scale = pageWidth / baseViewport.width
        const spans: TextSpan[] = []
        for (const item of content.items) {
          if (!('str' in item) || !item.str.trim()) continue
          const tx = item.transform
          const fontSize = Math.hypot(tx[2], tx[3]) * scale
          if (fontSize <= 0.5) continue
          spans.push({
            text: item.str,
            left: tx[4] * scale,
            top: (tx[5] - fontSize) * scale,
            fontSize,
            lineHeight: fontSize * 1.2
          })
        }
        setTextSpans(spans.length > 0 ? spans : undefined)
      })
      .catch(() => {
        // A text layer failure must never break the canvas preview.
        if (!canceled) setTextSpans(undefined)
      })

    return () => {
      canceled = true
    }
  }, [isNearViewport, pageEpoch, pageNumber, pageWidth])

  return (
    <div
      ref={setNearViewportRef}
      className={cn(
        'relative bg-bg-000 shadow-sm',
        // Alignment is owned by the parent column; fall back to a responsive width until it has
        // measured the fit width.
        pageWidth > 0 ? 'max-w-none' : 'w-full max-w-3xl'
      )}
      style={pageWidth > 0 ? { aspectRatio, width: pageWidth } : { aspectRatio }}
      data-page-number={pageNumber}
      // The workspace SelectionAnnotator reads this to label evidence picked from this page;
      // the resulting card names the PDF and the page, so the source passage stays locatable.
      data-annotation-source={`PDF · ${documentName} · p.${pageNumber}`}
      // A completed text selection becomes an annotation only while a marking mode is on: outside one,
      // selecting a passage means what it always meant (the evidence annotator, or a copy).
      onMouseUp={(event) => {
        if (!textMarkKind || !onTextMark) return
        const selection = readPdfPageSelection(event.currentTarget)
        if (selection) onTextMark(pageNumber, textMarkKind, selection)
      }}
    >
      {displayedStatus === 'loading' || (displayedStatus === 'idle' && isNearViewport) ? (
        <div className="absolute inset-0">
          <PreviewLoadingContent compact />
        </div>
      ) : null}
      {displayedStatus === 'error' ? (
        <div className="absolute inset-0 flex items-center justify-center text-[12px] text-text-300">
          Page {pageNumber} could not be rendered
        </div>
      ) : null}
      {isNearViewport ? (
        <canvas ref={canvasRef} width={0} height={0} className="block size-full object-contain" />
      ) : null}
      {/* The stored markup of the version on screen: above the canvas, below the text layer, and with
          pointer events off so it can never take a click meant for the passage under it. */}
      {isNearViewport && marks && marks.length > 0 ? <PdfAnnotationMarks marks={marks} /> : null}
      {/* Selectable text layer: positioned exactly over the canvas so the annotator can select
          a passage as evidence. The wrapper ignores pointer events (scroll/wheel pass through to
          the scroller); each span opts back in so the text itself is selectable/copyable. */}
      {/* Region picking sits above the text layer on purpose: while it is on, a drag draws a region
          rather than selecting a passage, and the reader can see that from the crosshair. */}
      {regionMode && onRegion && isNearViewport ? (
        <PdfRegionOverlay
          onRegion={(rect) => onRegion(pageNumber, rect)}
          onPress={onPagePress ? (point) => onPagePress(pageNumber, point) : undefined}
        />
      ) : null}
      {isNearViewport && textSpans ? (
        <div className="pointer-events-none absolute inset-0" aria-hidden="false">
          {textSpans.map((span, index) => (
            <span
              key={index}
              data-slot="pdf-text-span"
              className="pointer-events-auto absolute origin-top-left whitespace-pre leading-none text-transparent"
              style={{
                left: span.left,
                top: span.top,
                fontSize: span.fontSize,
                lineHeight: span.lineHeight
              }}
            >
              {span.text}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  )
}

export const PdfPreviewContent = ({
  path,
  name,
  source = 'artifact',
  projectId,
  sessionId,
  artifactId,
  selectedVersionId,
  mimeType,
  size,
  mtimeMs
}: {
  path: string
  name: string
  source?: PreviewFileSource
  projectId?: string
  sessionId?: string
  artifactId?: string
  selectedVersionId?: string
  mimeType?: string
  size?: number
  mtimeMs?: number
}): React.JSX.Element => {
  const { t } = useLanguage()
  // A region bookmark is traceable only if there is a session to file it under and a version to reopen
  // it on; without both, the action is absent rather than storing an anchor that leads nowhere.
  const canRegionBookmark = Boolean(sessionId && artifactId && selectedVersionId && projectId)
  const [regionStatus, setRegionStatus] = useState<string | undefined>(undefined)

  // --- the annotation layer (文档标注层 A3) ------------------------------------------------------------
  //
  // One gesture state for the page, because two overlays competing for the same drag is how a reader ends
  // up with the wrong thing stored. The annotation surface is used only when the window can name the file
  // VERSION: the anchor is (file, version, checksum) and the checksum is resolved in the main process, so
  // without the identity there is no anchor to write — the same rule the region bookmark above follows.
  const annotationClient = window.api?.pdfAnnotations
  // Memoized so the read below depends on the four identity facts rather than on a fresh object every
  // render: an identity that has not changed must not re-read the store on every keystroke elsewhere.
  const anchorRequest: PdfAnnotationAnchorRequest | undefined = useMemo(
    () =>
      projectId && sessionId && artifactId && selectedVersionId
        ? { projectId, sessionId, artifactId, versionId: selectedVersionId }
        : undefined,
    [projectId, sessionId, artifactId, selectedVersionId]
  )
  const canAnnotate = Boolean(annotationClient && anchorRequest)
  const [gestureMode, setGestureMode] = useState<
    'off' | 'bookmark-region' | 'highlight' | 'underline' | 'area' | 'page-note'
  >('off')
  const [annotationList, setAnnotationList] = useState<PdfAnnotationListResult | undefined>(
    undefined
  )
  const [annotationLoadError, setAnnotationLoadError] = useState<string | undefined>(undefined)
  const [annotationReload, setAnnotationReload] = useState(0)
  const [annotationStatus, setAnnotationStatus] = useState<string | undefined>(undefined)
  const [panelOpen, setPanelOpen] = useState(false)
  const [importer, setImporter] = useState<PdfAnnotationImportView>({ kind: 'idle' })
  const [exporter, setExporter] = useState<PdfAnnotationExportView>({ kind: 'idle' })
  const [pendingNote, setPendingNote] = useState<
    { page: number; anchorRect: BookmarkRect } | undefined
  >(undefined)
  const [noteBody, setNoteBody] = useState('')

  const reloadAnnotations = (): void => setAnnotationReload((value) => value + 1)
  const describeFailure = (error: unknown): string =>
    error instanceof Error ? error.message : String(error)

  // Reads the stored annotations of this file (every version of it — an annotation drawn on other bytes is
  // labelled rather than hidden) whenever the previewed version changes or something was just written.
  useEffect(() => {
    if (!annotationClient || !anchorRequest) return
    let canceled = false
    void annotationClient
      .list(anchorRequest)
      .then((result) => {
        if (canceled) return
        setAnnotationList(result)
        setAnnotationLoadError(undefined)
      })
      .catch((error: unknown) => {
        if (canceled) return
        setAnnotationList(undefined)
        setAnnotationLoadError(describeFailure(error))
      })
    return () => {
      canceled = true
    }
  }, [annotationClient, anchorRequest, annotationReload])

  const counts: PdfAnnotationAnchorCounts = annotationList?.counts ?? {
    current: 0,
    versionChanged: 0,
    checksumMismatch: 0
  }
  const marks = useMemo(
    () => pdfAnnotationMarks(annotationList?.annotations ?? []),
    [annotationList]
  )

  const writeAnnotation = (
    content: { kind: string; selector: unknown; body?: string },
    done: string
  ): void => {
    if (!annotationClient || !anchorRequest) return
    void annotationClient
      .create({ ...anchorRequest, ...content })
      .then(() => {
        setAnnotationStatus(done)
        reloadAnnotations()
      })
      .catch((error: unknown) =>
        setAnnotationStatus(t('pdfAnnotation.status.failed', { message: describeFailure(error) }))
      )
  }

  const handleTextMark = (
    page: number,
    kind: 'highlight' | 'underline',
    selection: PdfTextSelection
  ): void => {
    writeAnnotation(
      {
        kind,
        selector: pdfAnnotationTextRangeSelector(page, selection),
        body: ''
      },
      t('pdfAnnotation.status.saved')
    )
  }

  // Placing a note is two steps on purpose: the click says WHERE, and the text says WHAT. Storing an empty
  // note on the click would be a note that annotates nothing, which the store refuses anyway.
  const handlePagePress = (page: number, point: { x: number; y: number }): void => {
    if (gestureMode !== 'page-note') return
    setPendingNote({ page, anchorRect: pdfAnnotationNoteAnchor(point) })
  }

  const saveNote = (): void => {
    if (!pendingNote) return
    writeAnnotation(
      {
        kind: 'page-note',
        selector: pdfAnnotationPageNoteSelector(pendingNote.page, pendingNote.anchorRect),
        body: noteBody
      },
      t('pdfAnnotation.status.saved')
    )
    setPendingNote(undefined)
    setNoteBody('')
  }

  // One drag, two meanings, decided here: while the reader is placing a region annotation the gesture
  // makes one, and while the region tool is on it makes the bookmark it always made. Deciding at the
  // gesture's end rather than by mounting two overlays keeps a single drag from ever storing two things.
  const handleRegionGesture = (page: number, rect: BookmarkRect): void => {
    if (gestureMode === 'area') {
      writeAnnotation(
        { kind: 'area', selector: pdfAnnotationAreaSelector(page, rect), body: '' },
        t('pdfAnnotation.status.saved')
      )
      return
    }
    if (gestureMode === 'bookmark-region') handleRegionBookmark(page, rect)
  }

  const handleDeleteAnnotation = (annotationId: string): void => {
    if (!annotationClient) return
    void annotationClient
      .remove({ annotationId })
      .then(() => {
        setAnnotationStatus(t('pdfAnnotation.status.deleted'))
        reloadAnnotations()
      })
      .catch((error: unknown) =>
        setAnnotationStatus(t('pdfAnnotation.status.failed', { message: describeFailure(error) }))
      )
  }

  // The only way an annotation crosses versions, and it is a write of a copy: the original stays on the
  // version it was drawn on, which is what makes the record of "drawn on these bytes" still true.
  const handleReattachAnnotation = (annotationId: string): void => {
    if (!annotationClient || !anchorRequest) return
    void annotationClient
      .reattach({ ...anchorRequest, annotationId })
      .then(() => {
        setAnnotationStatus(t('pdfAnnotation.status.reattached'))
        reloadAnnotations()
      })
      .catch((error: unknown) =>
        setAnnotationStatus(t('pdfAnnotation.status.failed', { message: describeFailure(error) }))
      )
  }

  // The two export channels (文档标注层 A4). Each is triggered on its own and lands its own file; the
  // request carries the file name the pane displays, and the main process decides the extension, the
  // checksum and the bytes. A channel that wrote nothing (a cancelled save, a named refusal) therefore
  // never leaves a receipt behind.
  const exportRequest: PdfAnnotationExportRequest | undefined = useMemo(
    () => (anchorRequest ? { ...anchorRequest, fileName: name } : undefined),
    [anchorRequest, name]
  )

  const runExport = (channel: PdfAnnotationExportChannel): void => {
    if (!annotationClient || !exportRequest) return
    setExporter({ kind: 'running', channel })
    const call =
      channel === 'notes'
        ? annotationClient.exportNotes(exportRequest)
        : annotationClient.exportAnnotated(exportRequest)
    void call
      .then((outcome) => {
        if (outcome.status === 'exported') {
          setExporter({ kind: 'receipt', receipt: outcome.receipt })
          // The store is read again after an export so the panel shows the store, not the export's hopes —
          // the same reason the counts are re-read after a create.
          reloadAnnotations()
          return
        }
        setExporter(
          outcome.status === 'cancelled'
            ? { kind: 'cancelled', channel }
            : { kind: 'failure', channel, code: outcome.code, message: outcome.message }
        )
      })
      .catch((error: unknown) =>
        setExporter({ kind: 'failed', channel, message: describeFailure(error) })
      )
  }

  const handleImport = (): void => {
    if (!annotationClient || !anchorRequest) return
    setImporter({ kind: 'running' })
    void annotationClient
      .import(anchorRequest)
      .then((outcome) => {
        setImporter(
          outcome.status === 'report'
            ? { kind: 'report', report: outcome.report }
            : { kind: 'failure', code: outcome.code, message: outcome.message }
        )
        if (outcome.status === 'report' && outcome.report.imported > 0) reloadAnnotations()
      })
      .catch((error: unknown) => setImporter({ kind: 'failed', message: describeFailure(error) }))
  }

  const handleRegionBookmark = (page: number, rect: BookmarkRect): void => {
    if (!sessionId || !artifactId || !selectedVersionId || !projectId) return
    void (async () => {
      // The identity is confirmed before anything is written: a preview can carry a version pair the
      // artifact store has never seen (measured on the packaged app), and a region pointing at that
      // would open an empty preview for the reader with no error anywhere.
      const identity = await resolveBookmarkVersionIdentity({
        projectId,
        sessionId,
        artifactId,
        versionId: selectedVersionId,
        name
      })
      if (!identity) {
        setRegionStatus(t('bookmark.versionUnresolved'))
        return
      }
      await window.api.bookmark.set({
        sessionId,
        anchor: {
          kind: 'pdf-region',
          page,
          rect,
          artifactVersionId: identity.versionId,
          locator: identity.locator
        }
      })
      setRegionStatus(t('pdfRegion.saved'))
    })().catch((cause: unknown) =>
      setRegionStatus(cause instanceof Error ? cause.message : String(cause))
    )
  }
  const requestKey = createPreviewResourceKey({
    projectId,
    sessionId,
    source,
    path,
    mimeType,
    size,
    mtimeMs
  })
  const [documentState, setDocumentState] = useState<DocumentState | null>(null)
  const [zoom, setZoom] = useState(1)
  // The PreviewPanel path remounts on a file switch, but the Files-tab dialog updates item in place
  // with no contentKey, so reset zoom to fit whenever the previewed file changes (adjust-on-render).
  const [zoomedKey, setZoomedKey] = useState(requestKey)
  if (zoomedKey !== requestKey) {
    setZoomedKey(requestKey)
    setZoom(1)
  }
  // The width one page fills at 100%: the content box, capped to a comfortable reading width. Owned
  // here so one ResizeObserver serves the whole document instead of one per page.
  const [fitWidth, setFitWidth] = useState(0)
  // The real (uncapped) content-box width, used only to decide when a zoomed page actually
  // overflows the viewport — distinct from the capped fitWidth that sizes a 100% page.
  const [viewportWidth, setViewportWidth] = useState(0)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const measureRef = useRef<HTMLDivElement | null>(null)
  const pageDisposersRef = useRef(new Set<() => void>())
  const registerPageDisposer = useCallback((dispose: () => void): (() => void) => {
    pageDisposersRef.current.add(dispose)
    return () => pageDisposersRef.current.delete(dispose)
  }, [])

  // Ctrl/Cmd+wheel zooms the document instead of scrolling, matching the image preview gesture.
  // A trackpad/pinch emits many small wheel events per gesture, so accumulate deltaY and apply it
  // proportionally once per frame — one gesture yields a controlled zoom and few rerasterizations.
  // Keyed to requestKey and run as a layout effect so a file switch cancels any queued frame during
  // commit — before the browser's rAF phase — so a stale flush cannot re-apply zoom on top of the
  // new document's reset (a passive-effect cleanup would run after paint, too late to cancel it).
  useLayoutEffect(() => {
    const element = scrollRef.current
    if (!element) return

    let pendingDelta = 0
    let frame: number | undefined
    const flush = (): void => {
      frame = undefined
      const delta = pendingDelta
      pendingDelta = 0
      if (delta !== 0) setZoom((current) => clampZoom(current - delta * ZOOM_WHEEL_SENSITIVITY))
    }
    const handleWheel = (event: WheelEvent): void => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      pendingDelta += event.deltaY
      frame ??= requestAnimationFrame(flush)
    }

    element.addEventListener('wheel', handleWheel, { passive: false })
    return () => {
      element.removeEventListener('wheel', handleWheel)
      if (frame !== undefined) cancelAnimationFrame(frame)
    }
  }, [requestKey])

  // Measure the content-box width before paint (zero-height probe, unaffected by page overflow) so
  // pages rasterize once at the right width on open. Tracks the current width so pages stay
  // responsive: narrowing the panel (or returning from full screen) shrinks them back to fit.
  useLayoutEffect(() => {
    const element = measureRef.current
    if (!element) return

    const measure = (): void => {
      const raw = element.clientWidth
      if (raw <= 0) return
      const width = Math.min(raw, FIT_PAGE_WIDTH)
      setFitWidth((current) => (width === current ? current : width))
      setViewportWidth((current) => (raw === current ? current : raw))
    }
    measure()

    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    let canceled = false
    let document: PdfDocument | undefined
    let loadingTask: ReturnType<typeof createManagedPdfLoadingTask> | undefined
    let resourceId: string | undefined
    let disposePromise: Promise<void> | undefined
    const dispose = (): Promise<void> => {
      disposePromise ??= (async () => {
        // Cancel page renders before destroying their shared PDF.js document and resource.
        for (const disposePage of pageDisposersRef.current) disposePage()
        pageDisposersRef.current.clear()

        try {
          if (document) await document.destroy()
          else if (loadingTask) await loadingTask.destroy()
        } catch (error) {
          console.error('Failed to destroy PDF preview', error)
        }

        // Quiet on purpose: releasing while the application shuts down has nothing to release, and a
        // console error here fails unrelated certification specs (see releaseQuietly).
        if (resourceId) releaseQuietly(resourceId)
      })()
      return disposePromise
    }

    void (async () => {
      try {
        const resource = await window.api.previewResources.acquire({
          source,
          path,
          ...createPreviewRequestScope({ projectId, sessionId, source, path }),
          ...(mimeType ? { mimeType } : {})
        })
        resourceId = resource.id
        if (canceled) {
          await dispose()
          return
        }

        loadingTask = createManagedPdfLoadingTask(resource)
        document = await loadingTask.promise
        if (canceled) {
          await dispose()
          return
        }

        setDocumentState({ requestKey, status: 'ready', document })
      } catch (error: unknown) {
        if (!isUnavailableFileError(error)) console.error('Failed to load PDF preview', error)
        if (!canceled) setDocumentState({ requestKey, status: 'error', error })
        await dispose()
      }
    })()

    return () => {
      canceled = true
      if (resourceId) void dispose()
    }
  }, [mimeType, path, projectId, requestKey, sessionId, source])

  const currentDocumentState = documentState?.requestKey === requestKey ? documentState : null
  const hasError = currentDocumentState?.status === 'error'

  if (hasError) {
    return (
      <PreviewErrorCard
        name={name}
        error={currentDocumentState.error}
        fallbackMessage="This PDF couldn't be rendered for preview"
      />
    )
  }

  const document = currentDocumentState?.status === 'ready' ? currentDocumentState.document : null
  const pageCount = document?.numPages ?? 0
  const pageWidth = fitWidth > 0 ? Math.round(fitWidth * zoom) : 0
  const zoomBy = (delta: number): void => setZoom((current) => clampZoom(current + delta))

  return (
    <div className="relative size-full overflow-hidden bg-bg-20">
      {/* The inner element is the real scroller (the outer div holds the fixed zoom overlay), so it
          must be keyboard-focusable or PageUp/Down, Space, and arrows never reach the PDF. */}
      <div
        ref={scrollRef}
        className="size-full overflow-auto p-4 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50"
        tabIndex={0}
        role="region"
        aria-label={`${name} scrollable preview`}
      >
        {/* Zero-height probe: reports the content-box width even when pages overflow horizontally. */}
        <div ref={measureRef} className="h-0 w-full" aria-hidden="true" />
        {!document ? (
          <div className="absolute inset-0">
            <PreviewLoadingContent />
          </div>
        ) : null}
        {document ? (
          // Center pages while they fit the real viewport, but left-align once a zoomed page
          // overflows it: a centered overflow puts the left margin before scrollLeft=0, making it
          // unreachable. Compared against the uncapped viewport width, not the reading-width cap,
          // so a page still fitting a wide/full-screen pane stays centered.
          <div
            className={cn(
              'flex min-w-full flex-col gap-3',
              viewportWidth > 0 && pageWidth > viewportWidth ? 'items-start' : 'items-center'
            )}
          >
            {Array.from({ length: pageCount }, (_, index) => (
              // Each page mounts its canvas only inside the viewport overscan window.
              <PdfPageCanvas
                key={index + 1}
                document={document}
                pageNumber={index + 1}
                pageWidth={pageWidth}
                documentName={name}
                registerDisposer={registerPageDisposer}
                regionMode={
                  gestureMode === 'bookmark-region' ||
                  gestureMode === 'area' ||
                  gestureMode === 'page-note'
                }
                onRegion={handleRegionGesture}
                onPagePress={handlePagePress}
                textMarkKind={
                  gestureMode === 'highlight' || gestureMode === 'underline'
                    ? gestureMode
                    : undefined
                }
                onTextMark={handleTextMark}
                marks={marks.filter((mark) => mark.page === index + 1)}
              />
            ))}
          </div>
        ) : null}
      </div>
      {document && (canRegionBookmark || canAnnotate) ? (
        <div className="absolute bottom-3 left-3 z-10 flex items-center gap-1 rounded-md border border-border-300/50 bg-bg-000/90 p-1 shadow-sm backdrop-blur">
          <TooltipProvider delayDuration={300}>
            {canAnnotate
              ? ANNOTATION_MODES.map(({ mode, labelKey, Icon }) => (
                  <Tooltip key={mode}>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        data-slot={`pdf-annotation-mode-${mode}`}
                        aria-pressed={gestureMode === mode}
                        aria-label={t(labelKey)}
                        className={gestureMode === mode ? 'text-primary' : 'text-text-100'}
                        onClick={() => {
                          setAnnotationStatus(undefined)
                          setPendingNote(undefined)
                          setGestureMode((current) => (current === mode ? 'off' : mode))
                        }}
                      >
                        <Icon aria-hidden="true" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{t(labelKey)}</TooltipContent>
                  </Tooltip>
                ))
              : null}
            {canRegionBookmark ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    data-slot="pdf-region-toggle"
                    aria-pressed={gestureMode === 'bookmark-region'}
                    aria-label={t('pdfRegion.mode')}
                    onClick={() => {
                      setRegionStatus(undefined)
                      setGestureMode((current) =>
                        current === 'bookmark-region' ? 'off' : 'bookmark-region'
                      )
                    }}
                  >
                    <SquareDashed aria-hidden="true" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t('pdfRegion.mode')}</TooltipContent>
              </Tooltip>
            ) : null}
            {canAnnotate ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    data-slot="pdf-annotation-panel-toggle"
                    aria-expanded={panelOpen}
                    aria-label={t('pdfAnnotation.panel.title')}
                    onClick={() => setPanelOpen((open) => !open)}
                  >
                    <List aria-hidden="true" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t('pdfAnnotation.panel.title')}</TooltipContent>
              </Tooltip>
            ) : null}
          </TooltipProvider>
        </div>
      ) : null}
      {/* What the reader has to do next, in words: a crosshair alone does not say whether the next drag
          makes a highlight, a region or a note. */}
      {document && gestureMode !== 'off' ? (
        <p
          data-testid="pdf-annotation-hint"
          className="absolute left-3 top-3 z-10 rounded border border-border-300/50 bg-bg-000/90 px-2 py-1 text-[11px] text-text-100 backdrop-blur"
        >
          {t(ANNOTATION_HINT_KEYS[gestureMode])}
        </p>
      ) : null}
      {document ? (
        <PdfZoomControls
          zoom={zoom}
          onZoomIn={() => zoomBy(ZOOM_BUTTON_STEP)}
          onZoomOut={() => zoomBy(-ZOOM_BUTTON_STEP)}
          onReset={() => setZoom(1)}
        />
      ) : null}
      {document && canAnnotate && panelOpen ? (
        <PdfAnnotationPanel
          annotations={annotationList?.annotations ?? []}
          counts={counts}
          anchor={annotationList?.anchor}
          loadError={annotationLoadError}
          onDelete={handleDeleteAnnotation}
          onReattach={handleReattachAnnotation}
          pendingNote={pendingNote}
          noteBody={noteBody}
          onNoteBodyChange={setNoteBody}
          onNoteSave={saveNote}
          onNoteCancel={() => {
            setPendingNote(undefined)
            setNoteBody('')
          }}
          importer={importer}
          onImport={handleImport}
          exporter={exporter}
          onExportAnnotated={() => runExport('annotated-pdf')}
          onExportNotes={() => runExport('notes')}
          onClose={() => setPanelOpen(false)}
        />
      ) : null}
      {annotationStatus ? (
        <p
          data-testid="pdf-annotation-status"
          role="status"
          className="absolute bottom-3 left-1/2 z-10 -translate-x-1/2 rounded border border-border-300/50 bg-bg-000/90 px-2 py-1 text-[11px] text-text-100 backdrop-blur"
        >
          {annotationStatus}
        </p>
      ) : null}
      {regionStatus ? (
        <p
          role="status"
          className="absolute left-3 top-3 z-10 rounded border border-border-300/50 bg-bg-000/90 px-2 py-1 text-[11px] text-text-100 backdrop-blur"
        >
          {regionStatus}
        </p>
      ) : null}
    </div>
  )
}

export const PdfPreviewRenderer = ({ item }: PreviewFileRendererProps): React.JSX.Element => (
  <PdfPreviewContent
    path={item.path}
    name={item.name}
    source={item.source}
    projectId={item.projectId}
    sessionId={item.sessionId}
    artifactId={item.artifactId}
    selectedVersionId={item.selectedVersionId}
    mimeType={item.mimeType}
    size={item.size}
    mtimeMs={item.mtimeMs}
  />
)
