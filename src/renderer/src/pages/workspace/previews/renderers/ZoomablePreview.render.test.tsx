// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ZoomablePreview } from './ZoomablePreview'

/**
 * How long a coordination wait may take.
 *
 * Every `vi.waitFor` in this file is a *coordination* wait: it waits for the side effect of work that
 * is already in flight (a spy being called, a process dying, a worker reporting that it started, a
 * rendered node reaching its final text), never for something that may never happen. The only thing
 * the window has to cover is how long a loaded machine takes to schedule that continuation -- so the
 * default 1s is a quiet-machine budget, not a correctness budget. Measured on this repository: under
 * load a coordinated wait took up to 704ms (34 samples, p90 = 361ms), and a site elsewhere in the
 * suite failed at ~1.1s under load average ~70 while passing on a quiet machine.
 *
 * 30s matches the window this repository already uses for load-sensitive waits, and it stays well below
 * vitest's 60s per-test timeout, so an assertion that is genuinely stuck still fails as a failure
 * instead of hanging.
 */
const COORDINATION_WINDOW_MS = 30_000

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

const renderPreview = (resetKey?: string): void => {
  act(() => {
    root.render(
      <ZoomablePreview resetKey={resetKey}>
        <img alt="figure" src="blob:figure" />
      </ZoomablePreview>
    )
  })
}

const zoomReadout = (): string =>
  container.querySelector('[data-testid="zoom-level"]')?.textContent ?? ''

const button = (label: string): HTMLButtonElement | null =>
  container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)

describe('ZoomablePreview', () => {
  it('renders the zoom controls with a 100% starting readout', async () => {
    renderPreview()
    expect(button('Zoom in')).not.toBeNull()
    expect(button('Zoom out')).not.toBeNull()
    expect(button('Reset zoom')).not.toBeNull()
    await vi.waitFor(() => expect(zoomReadout()).toBe('100%'), { timeout: COORDINATION_WINDOW_MS })
    expect(container.querySelector('img')?.getAttribute('alt')).toBe('figure')
  })

  it('raises the readout when zoomed in and returns to 100% on reset', async () => {
    renderPreview()
    await vi.waitFor(() => expect(zoomReadout()).toBe('100%'), { timeout: COORDINATION_WINDOW_MS })

    act(() => button('Zoom in')?.click())
    await vi.waitFor(() => expect(zoomReadout()).not.toBe('100%'), {
      timeout: COORDINATION_WINDOW_MS
    })

    act(() => button('Reset zoom')?.click())
    await vi.waitFor(() => expect(zoomReadout()).toBe('100%'), { timeout: COORDINATION_WINDOW_MS })
  })

  it('keeps a single zoom surface when the reset key is unchanged', async () => {
    renderPreview('figures/panel-a.png')
    await vi.waitFor(() => expect(zoomReadout()).toBe('100%'), { timeout: COORDINATION_WINDOW_MS })
    expect(container.querySelectorAll('[data-testid="zoom-level"]')).toHaveLength(1)
  })

  it('resets the zoom readout when the reset key changes (file switch)', async () => {
    renderPreview('figures/panel-a.png')
    await vi.waitFor(() => expect(zoomReadout()).toBe('100%'), { timeout: COORDINATION_WINDOW_MS })

    act(() => button('Zoom in')?.click())
    await vi.waitFor(() => expect(zoomReadout()).not.toBe('100%'), {
      timeout: COORDINATION_WINDOW_MS
    })

    renderPreview('figures/panel-b.png')
    await vi.waitFor(() => expect(zoomReadout()).toBe('100%'), { timeout: COORDINATION_WINDOW_MS })
  })
})
