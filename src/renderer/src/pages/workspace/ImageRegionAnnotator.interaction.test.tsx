// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

import type { AnnotationImageRef, AnnotationRegion } from '../../../../shared/annotations'
import { ImageRegionAnnotator } from './ImageRegionAnnotator'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const IMAGE: AnnotationImageRef = { mediaPath: 'image-1' }

const mockRect = (element: Element): void => {
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({
    left: 0,
    top: 0,
    right: 400,
    bottom: 300,
    width: 400,
    height: 300,
    x: 0,
    y: 0,
    toJSON: () => ({})
  } as DOMRect)
}

const fire = (target: EventTarget, type: string, clientX: number, clientY: number): void => {
  target.dispatchEvent(new MouseEvent(type, { clientX, clientY, bubbles: true }))
}

describe('ImageRegionAnnotator', () => {
  let container: HTMLDivElement
  let root: Root
  let onAnnotate: Mock<(image: AnnotationImageRef, region: AnnotationRegion) => void>

  const render = (): HTMLElement => {
    const element = document.createElement('div')
    container.appendChild(element)
    root = createRoot(element)
    act(() => {
      root.render(
        <ImageRegionAnnotator image={IMAGE} onAnnotate={onAnnotate}>
          <img src="data:image/png;base64,AAA=" alt="test" />
        </ImageRegionAnnotator>
      )
    })
    const annotator = container.querySelector('[data-testid="image-region-annotator"]') as HTMLElement
    mockRect(annotator)
    return annotator
  }

  const picker = (annotator: HTMLElement): HTMLElement =>
    annotator.querySelector('[data-testid="annotation-image-picker"]') as HTMLElement
  const overlay = (annotator: HTMLElement): HTMLElement =>
    annotator.querySelector('[data-testid="annotation-region-overlay"]') as HTMLElement
  const button = (annotator: HTMLElement, testid: string): HTMLElement =>
    annotator.querySelector(`[data-testid="${testid}"]`) as HTMLElement

  const dragSelect = (annotator: HTMLElement, fromX: number, fromY: number, toX: number, toY: number): void => {
    const pickerEl = picker(annotator)
    if (pickerEl) {
      act(() => {
        pickerEl.click()
      })
    }
    act(() => {
      fire(annotator, 'mousedown', fromX, fromY)
    })
    act(() => {
      fire(document, 'mousemove', toX, toY)
    })
    act(() => {
      fire(document, 'mouseup', toX, toY)
    })
  }

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    onAnnotate = vi.fn()
  })

  afterEach(() => {
    act(() => root?.unmount())
    container.remove()
    vi.restoreAllMocks()
  })

  it('starts in idle mode with only the picker visible', () => {
    const annotator = render()
    expect(picker(annotator)).toBeTruthy()
    expect(overlay(annotator)).toBeNull()
    expect(button(annotator, 'annotation-confirm')).toBeNull()
  })

  it('drag-selects a region and shows the region overlay', () => {
    const annotator = render()
    picker(annotator).click()
    dragSelect(annotator, 100, 80, 160, 120)
    expect(overlay(annotator)).toBeTruthy()
    expect(button(annotator, 'annotation-confirm')).toBeTruthy()
  })

  it('confirm reports the normalized region', () => {
    const annotator = render()
    picker(annotator).click()
    dragSelect(annotator, 100, 80, 160, 120)
    act(() => {
      button(annotator, 'annotation-confirm').click()
    })
    expect(onAnnotate).toHaveBeenCalledTimes(1)
    const [, region] = onAnnotate.mock.calls[0] as [AnnotationImageRef, AnnotationRegion]
    expect(region.x).toBeCloseTo(0.25, 3)
    expect(region.y).toBeCloseTo(0.2667, 3)
    expect(region.width).toBeCloseTo(0.15, 3)
    expect(region.height).toBeCloseTo(0.1333, 3)
    // Back to idle after confirm.
    expect(overlay(annotator)).toBeNull()
    expect(picker(annotator)).toBeTruthy()
  })

  it('reselect clears the draft and allows a fresh selection', () => {
    const annotator = render()
    picker(annotator).click()
    dragSelect(annotator, 100, 80, 160, 120)
    act(() => {
      button(annotator, 'annotation-reselect').click()
    })
    expect(overlay(annotator)).toBeNull()
    dragSelect(annotator, 20, 30, 60, 70)
    expect(overlay(annotator)).toBeTruthy()
    act(() => {
      button(annotator, 'annotation-confirm').click()
    })
    const [, region] = onAnnotate.mock.calls[0] as [AnnotationImageRef, AnnotationRegion]
    expect(region.x).toBeCloseTo(0.05, 3)
    expect(region.y).toBeCloseTo(0.1, 3)
  })

  it('cancel exits back to idle without annotating', () => {
    const annotator = render()
    picker(annotator).click()
    dragSelect(annotator, 100, 80, 160, 120)
    act(() => {
      button(annotator, 'annotation-cancel').click()
    })
    expect(overlay(annotator)).toBeNull()
    expect(onAnnotate).not.toHaveBeenCalled()
    expect(picker(annotator)).toBeTruthy()
  })

  it('zoom enters the zoomed view with resize handles and rescales the image', () => {
    const annotator = render()
    picker(annotator).click()
    dragSelect(annotator, 100, 80, 160, 120)
    act(() => {
      button(annotator, 'annotation-zoom').click()
    })
    const handles = annotator.querySelectorAll('[data-testid^="annotation-corner-"]')
    expect(handles.length).toBe(4)
    expect(button(annotator, 'annotation-zoom')).toBeNull()
  })

  it('dragging a corner handle adjusts the region before confirm', () => {
    const annotator = render()
    picker(annotator).click()
    dragSelect(annotator, 100, 80, 160, 120)
    act(() => {
      button(annotator, 'annotation-zoom').click()
    })
    // SE handle: extends the region by (40, 30) px => (0.10, 0.10) normalized.
    const handle = annotator.querySelector('[data-testid="annotation-corner-se"]') as HTMLElement
    act(() => {
      fire(handle, 'mousedown', 160, 120)
    })
    act(() => {
      fire(document, 'mousemove', 200, 150)
    })
    act(() => {
      fire(document, 'mouseup', 200, 150)
    })
    act(() => {
      button(annotator, 'annotation-confirm').click()
    })
    const [, region] = onAnnotate.mock.calls[0] as [AnnotationImageRef, AnnotationRegion]
    expect(region.width).toBeCloseTo(0.25, 3)
    expect(region.height).toBeCloseTo(0.2333, 3)
  })

  it('ignores selections below the minimum region edge', () => {
    const annotator = render()
    picker(annotator).click()
    dragSelect(annotator, 100, 80, 102, 82)
    expect(overlay(annotator)).toBeNull()
    expect(button(annotator, 'annotation-confirm')).toBeNull()
  })
})
