// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ZoomablePreview } from './ZoomablePreview'

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
    await vi.waitFor(() => expect(zoomReadout()).toBe('100%'))
    expect(container.querySelector('img')?.getAttribute('alt')).toBe('figure')
  })

  it('raises the readout when zoomed in and returns to 100% on reset', async () => {
    renderPreview()
    await vi.waitFor(() => expect(zoomReadout()).toBe('100%'))

    act(() => button('Zoom in')?.click())
    await vi.waitFor(() => expect(zoomReadout()).not.toBe('100%'))

    act(() => button('Reset zoom')?.click())
    await vi.waitFor(() => expect(zoomReadout()).toBe('100%'))
  })

  it('keeps a single zoom surface when the reset key is unchanged', async () => {
    renderPreview('figures/panel-a.png')
    await vi.waitFor(() => expect(zoomReadout()).toBe('100%'))
    expect(container.querySelectorAll('[data-testid="zoom-level"]')).toHaveLength(1)
  })

  it('resets the zoom readout when the reset key changes (file switch)', async () => {
    renderPreview('figures/panel-a.png')
    await vi.waitFor(() => expect(zoomReadout()).toBe('100%'))

    act(() => button('Zoom in')?.click())
    await vi.waitFor(() => expect(zoomReadout()).not.toBe('100%'))

    renderPreview('figures/panel-b.png')
    await vi.waitFor(() => expect(zoomReadout()).toBe('100%'))
  })
})
