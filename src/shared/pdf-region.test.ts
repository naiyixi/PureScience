import { describe, expect, it } from 'vitest'

import { normalizePdfRegionDrag, PDF_REGION_MIN_EXTENT } from './pdf-region'

// The arithmetic is the whole feature, so it is tested directly: what a drag becomes, what it refuses to
// become, and the property that matters in practice — the same selection on a small and a large page
// normalizes to the same rectangle.

describe('normalizePdfRegionDrag', () => {
  const page = { width: 1000, height: 800 }

  it('turns a drag into a normalized rectangle', () => {
    expect(normalizePdfRegionDrag({ x: 100, y: 200 }, { x: 350, y: 400 }, page)).toEqual({
      x: 0.1,
      y: 0.25,
      width: 0.25,
      height: 0.25
    })
  })

  it('does not care which corner the drag started from', () => {
    const forward = normalizePdfRegionDrag({ x: 100, y: 200 }, { x: 350, y: 400 }, page)
    const backward = normalizePdfRegionDrag({ x: 350, y: 400 }, { x: 100, y: 200 }, page)
    expect(backward).toEqual(forward)
  })

  it('normalizes the same selection on a differently sized page to the same rectangle', () => {
    const smallPage = { width: 2000, height: 1600 }
    expect(normalizePdfRegionDrag({ x: 200, y: 400 }, { x: 700, y: 800 }, smallPage)).toEqual(
      normalizePdfRegionDrag({ x: 100, y: 200 }, { x: 350, y: 400 }, page)
    )
  })

  it('clamps a drag that left the page instead of storing coordinates off it', () => {
    expect(normalizePdfRegionDrag({ x: -50, y: -20 }, { x: 1200, y: 900 }, page)).toEqual({
      x: 0,
      y: 0,
      width: 1,
      height: 1
    })
  })

  it('refuses a click that is smaller than the minimum extent', () => {
    const tiny = PDF_REGION_MIN_EXTENT * page.width * 0.5
    expect(
      normalizePdfRegionDrag({ x: 100, y: 100 }, { x: 100 + tiny, y: 100 + tiny }, page)
    ).toBeUndefined()
  })

  // A page with no measurable box cannot produce coordinates, so nothing is stored at all.
  it('refuses a page with no measurable box', () => {
    expect(
      normalizePdfRegionDrag({ x: 0, y: 0 }, { x: 10, y: 10 }, { width: 0, height: 800 })
    ).toBeUndefined()
    expect(
      normalizePdfRegionDrag({ x: 0, y: 0 }, { x: 10, y: 10 }, { width: 0, height: 0 })
    ).toBeUndefined()
  })

  it('refuses coordinates that are not finite numbers', () => {
    expect(normalizePdfRegionDrag({ x: Number.NaN, y: 0 }, { x: 10, y: 10 }, page)).toBeUndefined()
    expect(
      normalizePdfRegionDrag({ x: 0, y: 0 }, { x: Number.POSITIVE_INFINITY, y: 10 }, page)
    ).toBeUndefined()
  })
})
