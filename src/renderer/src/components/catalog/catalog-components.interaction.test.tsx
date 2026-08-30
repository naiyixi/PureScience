// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CatalogFavoriteButton } from './CatalogFavoriteButton'
import { CatalogFilterChips } from './CatalogFilterChips'
import { CatalogTagEditor } from './CatalogTagEditor'
import { useCatalogTagsStore } from '@/stores/catalog-tags-store'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLElement
let root: Root

beforeEach(() => {
  window.localStorage.clear()
  useCatalogTagsStore.setState({ entries: {} })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

const render = (element: React.JSX.Element): void => {
  act(() => root.render(element))
}

describe('CatalogFavoriteButton', () => {
  it('toggles the favorite state and reflects it in aria-pressed', () => {
    render(<CatalogFavoriteButton resourceId="skill:alpha" label="Favorite skill alpha" />)
    const button = container.querySelector<HTMLButtonElement>('[data-testid="catalog-favorite"]')
    expect(button?.getAttribute('aria-pressed')).toBe('false')

    act(() => button?.click())
    expect(useCatalogTagsStore.getState().entries['skill:alpha']?.favorite).toBe(true)
    expect(
      container.querySelector<HTMLButtonElement>('[data-testid="catalog-favorite"]')?.getAttribute(
        'aria-pressed'
      )
    ).toBe('true')

    act(() => container.querySelector<HTMLButtonElement>('[data-testid="catalog-favorite"]')?.click())
    expect(useCatalogTagsStore.getState().entries['skill:alpha']?.favorite).toBe(false)
  })
})

describe('CatalogTagEditor', () => {
  it('adds a tag with Enter and removes it with the chip close button', () => {
    render(<CatalogTagEditor resourceId="skill:alpha" addLabel="Add tag" tagsLabel="Tags" />)
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="catalog-tag-add"]')?.click())

    const input = container.querySelector<HTMLInputElement>('[data-testid="catalog-tag-input"]')
    expect(input).not.toBeNull()
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value'
      )?.set
      setter?.call(input, 'docking')
      input?.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => {
      input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })

    expect(useCatalogTagsStore.getState().entries['skill:alpha']?.tags).toEqual(['docking'])
    const chips = container.querySelectorAll('[data-testid="catalog-tag"]')
    expect(chips).toHaveLength(1)

    act(() => chips[0].querySelector('button')?.click())
    expect(useCatalogTagsStore.getState().entries['skill:alpha']?.tags).toEqual([])
  })

  it('rejects empty input and closes the editor on blur', () => {
    render(<CatalogTagEditor resourceId="skill:alpha" addLabel="Add tag" tagsLabel="Tags" />)
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="catalog-tag-add"]')?.click())
    const input = container.querySelector<HTMLInputElement>('[data-testid="catalog-tag-input"]')
    act(() => {
      input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(useCatalogTagsStore.getState().entries['skill:alpha']).toBeUndefined()

    act(() => {
      input?.dispatchEvent(new FocusEvent('blur'))
    })
    expect(container.querySelector('[data-testid="catalog-tag-input"]')).toBeNull()
  })
})

describe('CatalogFilterChips', () => {
  const ids = ['skill:a', 'skill:b']

  it('shows All, Favorites and the tags present in the given resources', () => {
    useCatalogTagsStore.getState().addTag('skill:a', 'docking')
    useCatalogTagsStore.getState().addTag('skill:a', 'md')
    useCatalogTagsStore.getState().addTag('skill:b', 'md')

    render(
      <CatalogFilterChips
        resourceIds={ids}
        showFavorites={false}
        activeTags={[]}
        onToggleFavorites={vi.fn()}
        onToggleTag={vi.fn()}
        onClear={vi.fn()}
      />
    )

    const tagChips = [...container.querySelectorAll('[data-testid="catalog-filter-tag"]')]
    expect(tagChips.map((chip) => chip.textContent)).toEqual(['docking', 'md'])
    expect(container.textContent).toContain('Favorites')
    expect(container.textContent).toContain('All')
  })

  it('marks active chips pressed and fires the callbacks', () => {
    const onToggleFavorites = vi.fn()
    const onToggleTag = vi.fn()
    const onClear = vi.fn()
    render(
      <CatalogFilterChips
        resourceIds={ids}
        showFavorites
        activeTags={['md']}
        onToggleFavorites={onToggleFavorites}
        onToggleTag={onToggleTag}
        onClear={onClear}
      />
    )

    const favorites = container.querySelector<HTMLButtonElement>(
      '[data-testid="catalog-filter-favorites"]'
    )
    expect(favorites?.getAttribute('aria-pressed')).toBe('true')
    act(() => favorites?.click())
    expect(onToggleFavorites).toHaveBeenCalledTimes(1)

    const all = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
      button.textContent?.includes('All')
    )
    act(() => all?.click())
    expect(onClear).toHaveBeenCalledTimes(1)
  })
})
