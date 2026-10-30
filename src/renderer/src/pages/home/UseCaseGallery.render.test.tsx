// @vitest-environment jsdom
// The gallery's interaction loop, on the real component (no mocked internals): a card opens the panel,
// the panel shows that card's readings, its quote and its command, the copy control says it copied, and
// closing returns focus to the card that opened it.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { USE_CASE_SAMPLES } from './use-case-gallery'
import { UseCaseGallery } from './UseCaseGallery'

let container: HTMLDivElement
let root: Root

const settle = async (): Promise<void> => {
  // Radix restores focus in a close-autofocus handler that lands after the state update; two macrotasks
  // is the shortest wait that has proven stable in this tree.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

const query = (selector: string): HTMLElement | null =>
  document.body.querySelector<HTMLElement>(selector)

beforeEach(async () => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root.render(<UseCaseGallery />))
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
})

describe('use-case gallery', () => {
  it('renders one card per sample, each showing its first measured value', () => {
    const cards = document.body.querySelectorAll('[data-slot^="use-case-gallery-card-"]')
    expect(cards).toHaveLength(USE_CASE_SAMPLES.length)
    for (const sample of USE_CASE_SAMPLES) {
      const card = document.body.querySelector(`[data-slot="use-case-gallery-card-${sample.id}"]`)
      expect(card, sample.id).not.toBeNull()
      expect(card?.textContent).toContain(sample.readings[0].value)
    }
  })

  it('opens the panel with that card’s readings, quote and command', async () => {
    const sample = USE_CASE_SAMPLES[0]
    const card = document.body.querySelector<HTMLElement>(
      `[data-slot="use-case-gallery-card-${sample.id}"]`
    )
    await act(async () => card?.click())
    await settle()

    const dialog = query('[data-slot="use-case-gallery-dialog"]')
    expect(dialog).not.toBeNull()

    const readings = query('[data-slot="use-case-gallery-readings"]')
    for (const reading of sample.readings) {
      expect(readings?.textContent).toContain(reading.value)
    }
    const quotes = query('[data-slot="use-case-gallery-quotes"]')
    for (const quote of sample.quotes) {
      expect(quotes?.textContent).toContain(quote.text)
    }
    expect(query('[data-slot="use-case-gallery-command"]')?.textContent).toContain(sample.command)
  })

  it('confirms a copy instead of failing silently, and closes back to the card', async () => {
    const sample = USE_CASE_SAMPLES[0]
    const card = document.body.querySelector<HTMLElement>(
      `[data-slot="use-case-gallery-card-${sample.id}"]`
    )
    // jsdom's click() does not move focus the way a real click does, and the dialog's focus restore is
    // defined in terms of the element that had focus when it opened — so focus it explicitly.
    card?.focus()
    await act(async () => card?.click())
    await settle()

    const copy = query('[data-slot="use-case-gallery-copy"]')
    expect(copy?.textContent).toContain('Copy command')
    await act(async () => copy?.click())
    await settle()
    expect(query('[data-slot="use-case-gallery-copy"]')?.textContent).toContain('Copied')

    const close = document.body.querySelector<HTMLElement>('[aria-label="Close"]')
    await act(async () => close?.click())
    await settle()

    expect(query('[data-slot="use-case-gallery-dialog"]')).toBeNull()
    expect(document.activeElement).toBe(card)
  })
})
