// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DigitizationProvenance } from '../../../../shared/figure-to-data'
import { FigurePickOverlay } from './FigurePickOverlay'

let container: HTMLDivElement
let root: Root

const provenance: DigitizationProvenance = {
  sourcePath: 'data/paper.pdf',
  page: 2,
  figureRef: 'Fig. 2C',
  method: 'anchor-calibration'
}

beforeEach(() => {
  // jsdom reports a zero-sized box, which would clamp every keyboard placement onto the origin; a surface
  // laid out in the app has a real size, so the tests give it one.
  Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: (): DOMRect =>
      ({
        x: 0,
        y: 0,
        width: 400,
        height: 300,
        top: 0,
        left: 0,
        right: 400,
        bottom: 300,
        toJSON: () => ({})
      }) as DOMRect
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const render = (onExport?: (csv: string) => void): void => {
  act(() => {
    root.render(<FigurePickOverlay provenance={provenance} onExport={onExport} />)
  })
}

const text = (testId: string): string =>
  container.querySelector(`[data-testid="${testId}"]`)?.textContent ?? ''

const button = (label: string): HTMLButtonElement | null =>
  Array.from(container.querySelectorAll('button')).find((candidate) =>
    candidate.textContent?.includes(label)
  ) ?? null

const clickSurface = (clientX: number, clientY: number): void => {
  const surface = container.querySelector('[data-testid="figure-pick-surface"]') as HTMLDivElement
  act(() => {
    surface.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX, clientY }))
  })
}

const typeValue = (value: string): void => {
  const input = container.querySelector('input[aria-label="Tick value"]') as HTMLInputElement
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const surface = (): HTMLDivElement =>
  container.querySelector('[data-testid="figure-pick-surface"]') as HTMLDivElement

/** Moves the keyboard caret, and places a point there — the only two things a keyboard user does. */
const press = (key: string, options: { shift?: boolean } = {}): void => {
  act(() => {
    surface().dispatchEvent(
      new KeyboardEvent('keydown', { key, shiftKey: options.shift ?? false, bubbles: true })
    )
  })
}

const moveBy = (key: 'ArrowRight' | 'ArrowDown', steps: number): void => {
  for (let index = 0; index < steps; index += 1) press(key, { shift: true })
}

describe('FigurePickOverlay', () => {
  it('refuses a click before the tick value is entered, and says why', () => {
    render()
    expect(text('figure-pick-phase')).toContain('Calibrate the x axis')
    clickSurface(100, 120)
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Type the value of this tick mark first'
    )
    expect(text('figure-pick-progress')).toContain('x anchors 0/2')
  })

  it('collects x then y anchors and unlocks point picking', () => {
    render()
    for (const [value, x, y] of [
      ['0', 100, 0],
      ['40', 300, 0]
    ] as const) {
      typeValue(value)
      clickSurface(x, y)
    }
    expect(text('figure-pick-phase')).toContain('Calibrate the y axis')

    for (const [value, x, y] of [
      ['0', 0, 200],
      ['10', 0, 100]
    ] as const) {
      typeValue(value)
      clickSurface(x, y)
    }
    expect(text('figure-pick-phase')).toContain('Start clicking data points')

    clickSurface(200, 150)
    expect(text('figure-pick-progress')).toContain('data points 1')
  })

  it('exports CSV only once ready, with provenance and estimated status', () => {
    const onExport = vi.fn()
    render(onExport)

    expect(button('Export CSV (estimated)')?.disabled).toBe(true)

    for (const [value, x, y] of [
      ['0', 100, 0],
      ['40', 300, 0],
      ['0', 0, 200],
      ['10', 0, 100]
    ] as const) {
      typeValue(value)
      clickSurface(x, y)
    }
    clickSurface(200, 150)

    const exportButton = button('Export CSV (estimated)')
    expect(exportButton?.disabled).toBe(false)
    act(() => exportButton?.click())

    expect(onExport).toHaveBeenCalledTimes(1)
    const csv = onExport.mock.calls[0][0] as string
    expect(csv).toContain('# 数据来源：data/paper.pdf 第 2 页 Fig. 2C')
    expect(csv).toContain('# 状态：estimated · 需审查')
    expect(csv).toContain('x,y,pixel_x,pixel_y')
  })

  it('undoes the last point and clears the set on reset', () => {
    render()
    for (const [value, x, y] of [
      ['0', 100, 0],
      ['40', 300, 0],
      ['0', 0, 200],
      ['10', 0, 100]
    ] as const) {
      typeValue(value)
      clickSurface(x, y)
    }
    clickSurface(200, 150)
    clickSurface(220, 160)
    expect(text('figure-pick-progress')).toContain('data points 2')

    act(() => button('Undo last point')?.click())
    expect(text('figure-pick-progress')).toContain('data points 1')

    act(() => button('Start over')?.click())
    expect(text('figure-pick-phase')).toContain('Calibrate the x axis')
    expect(text('figure-pick-progress')).toBe('x anchors 0/2 · y anchors 0/2 · data points 0')
  })

  // The surface was a pointer-only action with a focus ring: the caret had to be a real one, and the user
  // had to be able to place every point — anchors and data alike — without touching a mouse.
  it('digitises a figure end to end with the keyboard alone', () => {
    const onExport = vi.fn()
    render(onExport)

    // x anchors: calibrate at two distinct pixels, each entered as a tick value.
    typeValue('0')
    moveBy('ArrowRight', 2)
    press('Enter')
    typeValue('40')
    moveBy('ArrowRight', 2)
    press('Enter')
    expect(text('figure-pick-phase')).toContain('Calibrate the y axis')

    // y anchors.
    typeValue('0')
    moveBy('ArrowDown', 2)
    press('Enter')
    typeValue('10')
    moveBy('ArrowDown', 2)
    press('Enter')
    expect(text('figure-pick-phase')).toContain('Start clicking data points')

    // data points.
    moveBy('ArrowRight', 1)
    press('Enter')
    moveBy('ArrowDown', 1)
    press('Enter')
    expect(text('figure-pick-progress')).toContain('data points 2')

    const exportButton = button('Export CSV (estimated)')
    expect(exportButton?.disabled).toBe(false)
    act(() => exportButton?.click())
    expect(onExport).toHaveBeenCalledTimes(1)
    expect(onExport.mock.calls[0][0] as string).toContain('x,y,pixel_x,pixel_y')
  })

  it('shows where the caret is, and says how to move it', () => {
    render()

    expect(surface().tabIndex).toBe(0)
    expect(text('figure-pick-keyboard-hint')).toContain('arrow keys move the caret')

    press('ArrowRight')
    expect(text('figure-pick-caret-status')).toContain('Caret x 201 · y 150')

    moveBy('ArrowDown', 2)
    expect(text('figure-pick-caret-status')).toContain('Caret x 201 · y 170')
  })

  it('undoes the last point from the keyboard, and refuses when there is none', () => {
    render()
    for (const [value, steps] of [
      ['0', 2],
      ['40', 4]
    ] as const) {
      typeValue(value)
      moveBy('ArrowRight', steps)
      press('Enter')
    }
    for (const [value, steps] of [
      ['0', 2],
      ['10', 4]
    ] as const) {
      typeValue(value)
      moveBy('ArrowDown', steps)
      press('Enter')
    }
    moveBy('ArrowRight', 1)
    press('Enter')
    moveBy('ArrowDown', 1)
    press('Enter')
    expect(text('figure-pick-progress')).toContain('data points 2')

    press('Backspace')
    expect(text('figure-pick-progress')).toContain('data points 1')

    press('Backspace')
    press('Backspace')
    expect(text('figure-pick-progress')).toContain('data points 0')
  })
})
