// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'

import {
  readPdfPageSelection,
  type SelectionLike,
  type SelectionRectLike
} from './pdf-annotation-selection'

// The gesture half of a highlight: what the browser reports as selected, turned into an anchor.
//
// The selection is fabricated here on purpose — the arithmetic (which rectangle, clipped to which box,
// rounded how) is what cannot be checked by reading the module, and jsdom has no real text layout to
// select from.

const PAGE = { left: 100, top: 50, width: 600, height: 800 }

const page = (): HTMLElement => {
  const element = document.createElement('div')
  element.getBoundingClientRect = () =>
    ({
      ...PAGE,
      right: PAGE.left + PAGE.width,
      bottom: PAGE.top + PAGE.height,
      x: PAGE.left,
      y: PAGE.top,
      toJSON: () => ({})
    }) as DOMRect
  return element
}

const rect = (left: number, top: number, right: number, bottom: number): SelectionRectLike => ({
  left,
  top,
  right,
  bottom,
  width: right - left,
  height: bottom - top
})

const selection = (text: string, rects: SelectionRectLike[]): SelectionLike => ({
  toString: () => text,
  rangeCount: 1,
  getRangeAt: () => ({ getClientRects: () => rects })
})

describe('reading a page selection as an anchor', () => {
  it('normalizes each selected line against the page box', () => {
    const result = readPdfPageSelection(page(), () =>
      selection('the effect is large', [rect(160, 130, 460, 150)])
    )

    // x: (160-100)/600 = 0.1, y: (130-50)/800 = 0.1, w: 300/600 = 0.5, h: 20/800 = 0.025
    expect(result).toEqual({
      quote: 'the effect is large',
      rects: [{ x: 0.1, y: 0.1, width: 0.5, height: 0.025 }]
    })
  })

  it('keeps one rectangle per line of a multi-line selection', () => {
    const result = readPdfPageSelection(page(), () =>
      selection('two lines here', [rect(160, 130, 460, 150), rect(100, 150, 400, 170)])
    )

    expect(result?.rects).toHaveLength(2)
    expect(result?.rects[1]).toEqual({ x: 0, y: 0.125, width: 0.5, height: 0.025 })
  })

  it('clips a rectangle that runs past the page box instead of storing it outside the page', () => {
    const result = readPdfPageSelection(page(), () =>
      selection('past the edge', [rect(500, 800, 900, 860)])
    )

    expect(result?.rects[0]).toEqual({ x: 0.6667, y: 0.9375, width: 0.3333, height: 0.0625 })
  })

  it('answers nothing for an empty selection, no selection at all, or rectangles off this page', () => {
    expect(
      readPdfPageSelection(page(), () => selection('   ', [rect(160, 130, 460, 150)]))
    ).toBeUndefined()
    expect(readPdfPageSelection(page(), () => null)).toBeUndefined()
    expect(
      readPdfPageSelection(page(), () => selection('elsewhere', [rect(900, 900, 950, 950)]))
    ).toBeUndefined()
  })

  it('reads the window selection when no reader is injected', () => {
    const getSelection = vi
      .spyOn(window, 'getSelection')
      .mockReturnValue(
        selection('from the window', [rect(160, 130, 460, 150)]) as unknown as Selection
      )

    expect(readPdfPageSelection(page())?.quote).toBe('from the window')
    getSelection.mockRestore()
  })
})
