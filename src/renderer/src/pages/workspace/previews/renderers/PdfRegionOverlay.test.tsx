// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PdfRegionOverlay } from './PdfRegionOverlay'

// The gesture is the part of a region bookmark that cannot be checked by reading it, so it is driven
// here: a drag stores a rectangle, a click stores nothing, and the stored rectangle is normalized to the
// page's own box rather than to the window.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

if (!Element.prototype.setPointerCapture) {
  Element.prototype.setPointerCapture = (): void => {}
  Element.prototype.releasePointerCapture = (): void => {}
  Element.prototype.hasPointerCapture = (): boolean => false
}

const PAGE = { width: 600, height: 800 }

let container: HTMLDivElement
let root: Root

const press = (element: HTMLElement, type: string, x: number, y: number): void => {
  element.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y }))
}

const overlay = (): HTMLElement =>
  container.querySelector('[data-slot="pdf-region-overlay"]') as HTMLElement

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  // jsdom reports a zero-sized box for everything; the overlay must be judged against a real page box.
  Element.prototype.getBoundingClientRect = function boxed(this: Element): DOMRect {
    return { ...PAGE, top: 0, left: 0, right: PAGE.width, bottom: PAGE.height, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
  }
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
})

describe('PdfRegionOverlay', () => {
  it('hands over the rectangle a drag described, normalized to the page box', () => {
    const onRegion = vi.fn()
    act(() => {
      root.render(<PdfRegionOverlay onRegion={onRegion} />)
    })

    act(() => {
      press(overlay(), 'pointerdown', 60, 80)
      press(overlay(), 'pointermove', 360, 480)
      press(overlay(), 'pointerup', 360, 480)
    })

    expect(onRegion).toHaveBeenCalledWith({ x: 0.1, y: 0.1, width: 0.5, height: 0.5 })
  })

  // A press that never moved is a click, not a region: nothing is stored.
  it('stores nothing when the gesture was a click', () => {
    const onRegion = vi.fn()
    act(() => {
      root.render(<PdfRegionOverlay onRegion={onRegion} />)
    })

    act(() => {
      press(overlay(), 'pointerdown', 60, 80)
      press(overlay(), 'pointerup', 60, 80)
    })

    expect(onRegion).not.toHaveBeenCalled()
  })

  it('shows the rubber band while the drag is in progress and clears it afterwards', () => {
    const onRegion = vi.fn()
    act(() => {
      root.render(<PdfRegionOverlay onRegion={onRegion} />)
    })

    act(() => {
      press(overlay(), 'pointerdown', 10, 10)
      press(overlay(), 'pointermove', 110, 210)
    })
    expect(container.querySelector('[data-slot="pdf-region-rubber-band"]')).not.toBeNull()

    act(() => {
      press(overlay(), 'pointerup', 110, 210)
    })
    expect(container.querySelector('[data-slot="pdf-region-rubber-band"]')).toBeNull()
  })
})
