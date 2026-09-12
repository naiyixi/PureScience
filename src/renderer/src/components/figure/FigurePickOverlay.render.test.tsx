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
  const input = container.querySelector('input[aria-label="刻度数值"]') as HTMLInputElement
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('FigurePickOverlay', () => {
  it('refuses a click before the tick value is entered, and says why', () => {
    render()
    expect(text('figure-pick-phase')).toContain('标定 x 轴')
    clickSurface(100, 120)
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      '先输入该刻度对应的数值'
    )
    expect(text('figure-pick-progress')).toContain('x 锚点 0/2')
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
    expect(text('figure-pick-phase')).toContain('标定 y 轴')

    for (const [value, x, y] of [
      ['0', 0, 200],
      ['10', 0, 100]
    ] as const) {
      typeValue(value)
      clickSurface(x, y)
    }
    expect(text('figure-pick-phase')).toContain('开始点击数据点')

    clickSurface(200, 150)
    expect(text('figure-pick-progress')).toContain('数据点 1')
  })

  it('exports CSV only once ready, with provenance and estimated status', () => {
    const onExport = vi.fn()
    render(onExport)

    expect(button('导出 CSV')?.disabled).toBe(true)

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

    const exportButton = button('导出 CSV')
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
    expect(text('figure-pick-progress')).toContain('数据点 2')

    act(() => button('撤销上一个点')?.click())
    expect(text('figure-pick-progress')).toContain('数据点 1')

    act(() => button('重新开始')?.click())
    expect(text('figure-pick-phase')).toContain('标定 x 轴')
    expect(text('figure-pick-progress')).toBe('x 锚点 0/2 · y 锚点 0/2 · 数据点 0')
  })
})
