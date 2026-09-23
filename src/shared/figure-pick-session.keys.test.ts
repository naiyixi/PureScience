import { describe, expect, it } from 'vitest'

import { FigureDigitizationError } from './figure-to-data'
import { addAnchor, addPick, startPickSession } from './figure-pick-session'

// The picking session is shared with the main process, so it cannot phrase its errors in the
// renderer dictionary. Every rejection therefore carries an i18n key next to an English fallback;
// this pins both halves so a future throw site cannot ship a sentence the UI cannot translate.
describe('figure pick session error keys', () => {
  const keyOf = (run: () => unknown): string | undefined => {
    try {
      run()
    } catch (cause) {
      return cause instanceof FigureDigitizationError ? cause.messageKey : undefined
    }
    return undefined
  }

  it('carries a key and an English fallback when the x axis is not calibrated', () => {
    expect(keyOf(() => addAnchor(startPickSession(), 'y', { pixel: 400, value: 0 }))).toBe(
      'figure.errorNeedXAnchors'
    )
  })

  it('carries a key when two anchors share a pixel', () => {
    const withAnchor = addAnchor(startPickSession(), 'x', { pixel: 100, value: 1 })
    expect(keyOf(() => addAnchor(withAnchor, 'x', { pixel: 100, value: 2 }))).toBe(
      'figure.errorDuplicateAnchor'
    )
  })

  it('carries a key when a data point is not finite', () => {
    const state = {
      ...startPickSession(),
      phase: 'picking' as const,
      xAnchors: [
        { pixel: 0, value: 0 },
        { pixel: 100, value: 1 }
      ],
      yAnchors: [
        { pixel: 100, value: 0 },
        { pixel: 0, value: 1 }
      ]
    }
    expect(keyOf(() => addPick(state, { x: Number.POSITIVE_INFINITY, y: 1 }))).toBe(
      'figure.errorPointFinite'
    )
  })
})
