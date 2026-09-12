// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FigureDigitizePanel } from './FigureDigitizePanel'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const text = (testId: string): string =>
  container.querySelector(`[data-testid="${testId}"]`)?.textContent ?? ''

const setInput = (testId: string, value: string): void => {
  const input = container.querySelector(`[data-testid="${testId}"]`) as HTMLInputElement
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('FigureDigitizePanel', () => {
  it('shows the source, an editable page and figure reference', () => {
    act(() => {
      root.render(<FigureDigitizePanel sourcePath="data/paper.pdf" defaultPage={3} />)
    })
    expect(text('digitize-source')).toBe('data/paper.pdf')
    expect(
      (container.querySelector('[data-testid="digitize-page"]') as HTMLInputElement).value
    ).toBe('3')
    expect(container.querySelector('[data-testid="digitize-figure-ref"]')).not.toBeNull()
  })

  it('demands an explicit page when the source is a multi-page document', () => {
    act(() => {
      root.render(<FigureDigitizePanel sourcePath="data/paper.pdf" requiresPageEntry />)
    })
    expect(text('digitize-page-required')).toContain('请确认页码')
  })

  it('refuses to let an invalid page produce usable provenance', () => {
    act(() => {
      root.render(<FigureDigitizePanel sourcePath="data/paper.pdf" />)
    })
    setInput('digitize-page', '0')
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('页码必须是 ≥1 的整数')
  })

  it('passes the confirmed page and figure reference into the exported CSV', () => {
    const onExport = vi.fn()
    act(() => {
      root.render(
        <FigureDigitizePanel
          sourcePath="data/paper.pdf"
          defaultPage={2}
          defaultFigureRef="Fig. 2C"
          onExport={onExport}
        />
      )
    })

    const surface = container.querySelector('[data-testid="figure-pick-surface"]') as HTMLDivElement
    const click = (clientX: number, clientY: number): void => {
      act(() => surface.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX, clientY })))
    }
    const typeTick = (value: string): void => {
      const input = container.querySelector('input[aria-label="刻度数值"]') as HTMLInputElement
      act(() => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
        setter?.call(input, value)
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
    }

    for (const [value, x, y] of [
      ['0', 100, 0],
      ['40', 300, 0],
      ['0', 0, 200],
      ['10', 0, 100]
    ] as const) {
      typeTick(value)
      click(x, y)
    }
    click(200, 150)

    const exportButton = Array.from(container.querySelectorAll('button')).find((candidate) =>
      candidate.textContent?.includes('导出 CSV')
    )
    act(() => exportButton?.click())

    expect(onExport).toHaveBeenCalledTimes(1)
    const csv = onExport.mock.calls[0][0] as string
    expect(csv).toContain('data/paper.pdf 第 2 页 Fig. 2C')
    expect(csv).toContain('# 状态：estimated · 需审查')
  })
})
