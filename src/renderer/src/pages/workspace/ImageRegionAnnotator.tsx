import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Crop, X, ZoomIn } from 'lucide-react'

import { useLanguage } from '@/i18n'
import { cn } from '@/lib/utils'
import {
  ANNOTATION_MIN_REGION_EDGE,
  type AnnotationImageRef,
  type AnnotationRegion
} from '../../../../shared/annotations'

type ImageRegionAnnotatorProps = {
  // Stable source image reference handed back to the caller on confirm.
  image: AnnotationImageRef
  onAnnotate: (image: AnnotationImageRef, region: AnnotationRegion) => void
  disabled?: boolean
  children: React.ReactNode
}

type Mode = 'idle' | 'selecting' | 'selected' | 'zoomed'
type Corner = 'nw' | 'ne' | 'sw' | 'se'

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value))

// Normalizes a client-space rectangle against the container bounds.
const toNormalizedRegion = (
  start: { x: number; y: number },
  end: { x: number; y: number },
  width: number,
  height: number
): AnnotationRegion => {
  if (width <= 0 || height <= 0) return { x: 0, y: 0, width: 0, height: 0 }
  const x = clamp01(Math.min(start.x, end.x) / width)
  const y = clamp01(Math.min(start.y, end.y) / height)
  return {
    x,
    y,
    width: clamp01(Math.abs(end.x - start.x) / width),
    height: clamp01(Math.abs(end.y - start.y) / height)
  }
}

const clampRegion = (region: AnnotationRegion): AnnotationRegion => {
  const x = clamp01(region.x)
  const y = clamp01(region.y)
  return {
    x,
    y,
    width: clamp01(region.width),
    height: clamp01(region.height)
  }
}

// Region selection overlay for agent-generated images: drag a rectangle, then zoom to
// fine-tune its edges, reselect, or confirm. Regions are normalized (0..1) so they survive
// responsive resizing; the caller turns them into an image annotation card.
const ImageRegionAnnotator = ({
  image,
  onAnnotate,
  disabled = false,
  children
}: ImageRegionAnnotatorProps): React.JSX.Element => {
  const { t } = useLanguage()
  const containerRef = useRef<HTMLDivElement>(null)
  const [mode, setMode] = useState<Mode>('idle')
  const [draft, setDraft] = useState<AnnotationRegion | null>(null)
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null)
  const [activeCorner, setActiveCorner] = useState<Corner | null>(null)

  const containerSize = (): { width: number; height: number } => {
    const rect = containerRef.current?.getBoundingClientRect()
    return { width: rect?.width ?? 0, height: rect?.height ?? 0 }
  }

  const clientToContainer = (clientX: number, clientY: number): { x: number; y: number } => {
    const rect = containerRef.current?.getBoundingClientRect()
    return { x: clientX - (rect?.left ?? 0), y: clientY - (rect?.top ?? 0) }
  }

  const onMouseDown = useCallback(
    (event: React.MouseEvent) => {
      if (disabled || mode !== 'selecting') return
      event.preventDefault()
      const point = clientToContainer(event.clientX, event.clientY)
      setDragStart(point)
      setDraft({ x: point.x, y: point.y, width: 0, height: 0 })
    },
    [disabled, mode]
  )

  const onMouseMove = useCallback(
    (event: MouseEvent) => {
      if (activeCorner) {
        // Corner-resize inside the zoomed view: the opposite corner stays anchored.
        if (!draft) return
        const point = clientToContainer(event.clientX, event.clientY)
        const next = { ...draft }
        if (activeCorner.includes('w')) {
          next.x = clamp01(
            Math.min(
              point.x / containerSize().width,
              draft.x + draft.width - ANNOTATION_MIN_REGION_EDGE
            )
          )
          next.width = draft.x + draft.width - next.x
        } else {
          next.width = clamp01(point.x / containerSize().width - draft.x)
        }
        if (activeCorner.includes('n')) {
          next.y = clamp01(
            Math.min(
              point.y / containerSize().height,
              draft.y + draft.height - ANNOTATION_MIN_REGION_EDGE
            )
          )
          next.height = draft.y + draft.height - next.y
        } else {
          next.height = clamp01(point.y / containerSize().height - draft.y)
        }
        setDraft(clampRegion(next))
        return
      }
      if (!dragStart || mode !== 'selecting') return
      const point = clientToContainer(event.clientX, event.clientY)
      const { width, height } = containerSize()
      setDraft(toNormalizedRegion(dragStart, point, width, height))
    },
    [activeCorner, dragStart, draft, mode]
  )

  const onMouseUp = useCallback(() => {
    if (activeCorner) {
      setActiveCorner(null)
      return
    }
    if (!dragStart || mode !== 'selecting') return
    setDragStart(null)
    if (
      draft &&
      draft.width >= ANNOTATION_MIN_REGION_EDGE &&
      draft.height >= ANNOTATION_MIN_REGION_EDGE
    ) {
      setMode('selected')
    } else {
      setDraft(null)
    }
  }, [activeCorner, dragStart, draft, mode])

  // Drag tracking lives on document so the selection keeps updating outside the image.
  useEffect(() => {
    if (mode !== 'selecting' && !activeCorner) return
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
    return () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }
  }, [mode, activeCorner, onMouseMove, onMouseUp])

  const confirm = (): void => {
    if (!draft) return
    onAnnotate(image, clampRegion(draft))
    setDraft(null)
    setMode('idle')
  }

  const reset = (): void => {
    setDraft(null)
    setDragStart(null)
    setActiveCorner(null)
    setMode('selecting')
  }

  const cancel = (): void => {
    setDraft(null)
    setDragStart(null)
    setActiveCorner(null)
    setMode('idle')
  }

  const zoomed = mode === 'zoomed'
  const regionStyle = draft
    ? {
        left: `${draft.x * 100}%`,
        top: `${draft.y * 100}%`,
        width: `${draft.width * 100}%`,
        height: `${draft.height * 100}%`
      }
    : undefined
  const zoomOrigin = draft
    ? `${(draft.x + draft.width / 2) * 100}% ${(draft.y + draft.height / 2) * 100}%`
    : '50% 50%'

  const cornerHandles: Corner[] = ['nw', 'ne', 'sw', 'se']

  return (
    <div
      ref={containerRef}
      data-testid="image-region-annotator"
      className={cn(
        'relative overflow-hidden rounded-lg border border-border-200',
        mode !== 'idle' && 'border-accent'
      )}
      onMouseDown={onMouseDown}
    >
      <div
        className={cn('transition-transform duration-150', zoomed && 'scale-[2]')}
        style={zoomed ? { transformOrigin: zoomOrigin } : undefined}
      >
        {children}
      </div>

      {/* Selection overlay */}
      {mode !== 'idle' && (
        <div
          className={cn('pointer-events-none absolute inset-0', zoomed && 'scale-[2]')}
          style={zoomed ? { transformOrigin: zoomOrigin } : undefined}
        >
          {draft && (
            <div
              data-testid="annotation-region-overlay"
              className="absolute border-2 border-accent bg-accent/20"
              style={regionStyle}
            >
              {mode === 'selected' && (
                <span className="absolute -top-6 left-0 whitespace-nowrap text-[10px] font-medium text-accent">
                  {t('ws.annotationImageRegionLabel')}
                </span>
              )}
            </div>
          )}
          {mode === 'zoomed' && draft && (
            <>
              {cornerHandles.map((corner) => (
                <button
                  key={corner}
                  type="button"
                  aria-label={`${t('ws.annotationImageResizeCorner')} ${corner}`}
                  data-testid={`annotation-corner-${corner}`}
                  onMouseDown={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    setActiveCorner(corner)
                  }}
                  className={cn(
                    'pointer-events-auto absolute size-3 cursor-nwse-resize rounded-full border border-white bg-accent',
                    corner === 'nw' && '-left-1.5 -top-1.5 cursor-nwse-resize',
                    corner === 'ne' && '-right-1.5 -top-1.5 cursor-nesw-resize',
                    corner === 'sw' && '-bottom-1.5 -left-1.5 cursor-nesw-resize',
                    corner === 'se' && '-bottom-1.5 -right-1.5 cursor-nwse-resize'
                  )}
                  style={regionStyle}
                />
              ))}
            </>
          )}
        </div>
      )}

      {/* Region hint while dragging */}
      {mode === 'selecting' && (
        <span className="pointer-events-none absolute inset-x-0 top-2 text-center text-[10px] text-text-100">
          {t('ws.annotationImageHint')}
        </span>
      )}

      {/* Toolbar */}
      {mode === 'idle' ? (
        !disabled && (
          <button
            type="button"
            data-testid="annotation-image-picker"
            aria-label={t('ws.annotationImagePicker')}
            onClick={() => setMode('selecting')}
            className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-md bg-bg-000/90 px-2 py-1 text-[11px] text-text-100 shadow-sm ring-1 ring-border-200 backdrop-blur transition-colors hover:text-foreground"
          >
            <Crop className="size-3" aria-hidden="true" />
            {t('ws.annotationImagePicker')}
          </button>
        )
      ) : (
        <div className="absolute bottom-2 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-lg bg-bg-000/95 px-1.5 py-1 shadow-md ring-1 ring-border-200 backdrop-blur">
          {mode === 'selected' && (
            <button
              type="button"
              data-testid="annotation-zoom"
              aria-label={t('ws.annotationImageZoom')}
              onClick={() => setMode('zoomed')}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-text-100 transition-colors hover:bg-bg-200 hover:text-foreground"
            >
              <ZoomIn className="size-3" aria-hidden="true" />
              {t('ws.annotationImageZoom')}
            </button>
          )}
          <button
            type="button"
            data-testid="annotation-reselect"
            aria-label={t('ws.annotationImageReselect')}
            onClick={reset}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-text-100 transition-colors hover:bg-bg-200 hover:text-foreground"
          >
            {t('ws.annotationImageReselect')}
          </button>
          <button
            type="button"
            data-testid="annotation-cancel"
            aria-label={t('ws.annotationImageCancel')}
            onClick={cancel}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-text-100 transition-colors hover:bg-bg-200 hover:text-foreground"
          >
            <X className="size-3" aria-hidden="true" />
            {t('ws.annotationImageCancel')}
          </button>
          {(mode === 'selected' || mode === 'zoomed') && (
            <button
              type="button"
              data-testid="annotation-confirm"
              aria-label={t('ws.annotationImageConfirm')}
              onClick={confirm}
              disabled={!draft}
              className="inline-flex items-center gap-1 rounded-md bg-accent px-2 py-1 text-[11px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              <Check className="size-3" aria-hidden="true" />
              {t('ws.annotationImageConfirm')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

export { ImageRegionAnnotator }
