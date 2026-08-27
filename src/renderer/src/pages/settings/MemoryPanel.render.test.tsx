// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n', () => ({
  useLanguage: () => {
    const labels: Record<string, string> = {
      'settings.memoryTitle': 'Memory',
      'settings.memoryDescription': 'Editable notes about you.',
      'settings.memoryEnabled': 'Memory switch',
      'settings.memoryClearAll': 'Clear all',
      'settings.memoryAddCategory': 'New category',
      'settings.memoryNewCategory': 'New category',
      'settings.memoryEmpty': 'Select a category',
      'settings.memoryAddNote': 'Add note',
      'settings.memoryNoNotes': 'No notes yet.',
      'settings.memoryNotePlaceholder': 'Write…',
      'settings.memoryDeleteNote': 'Delete note',
      'settings.memoryDisabledHint': 'Memory is off.'
    }
    return { t: (key: string): string => labels[key] ?? key }
  }
}))

const { MemoryPanel } = await import('./MemoryPanel')
const { useMemoryStore } = await import('@/stores/memory-store')

const memoryFixture = {
  enabled: true,
  categories: [
    { id: 'about-you', name: 'About you', createdAt: 1000 },
    { id: 'research', name: 'Research', createdAt: 1100 }
  ],
  notes: [
    {
      id: 'note-1',
      categoryId: 'about-you',
      text: 'Prefers concise answers',
      createdAt: 1001,
      updatedAt: 1002
    }
  ]
}

describe('MemoryPanel', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    useMemoryStore.setState({
      memory: memoryFixture,
      isLoading: false,
      // Mirror the real updateMemory contract: persist then replace the cache, so the panel
      // re-renders from the authoritative value (enabled hint, category selection, note counts).
      updateMemory: vi.fn(async (memory: unknown) => {
        useMemoryStore.setState({ memory: memory as typeof memoryFixture })
      }),
      loadMemory: vi.fn(async () => memoryFixture)
    })
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  const renderPanel = (): Promise<void> =>
    act(async () => {
      root.render(<MemoryPanel />)
    })

  it('renders categories, notes, and the master switch', async () => {
    await renderPanel()

    expect(container.querySelector('[data-memory-enabled]')?.getAttribute('data-memory-enabled')).toBe('true')
    expect(container.textContent).toContain('About you')
    expect(container.textContent).toContain('Research')
    expect(container.textContent).toContain('Prefers concise answers')
  })

  it('adds a note to the selected category and persists', async () => {
    await renderPanel()

    const addNoteButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Add note')
    )
    await act(async () => {
      addNoteButton?.click()
    })

    const updateMemory = useMemoryStore.getState().updateMemory as ReturnType<typeof vi.fn>
    const persisted = updateMemory.mock.calls.at(-1)?.[0]
    expect(persisted.notes).toHaveLength(2)
    expect(persisted.notes[0].categoryId).toBe('about-you')
  })

  it('creates a category and switches the selection to it', async () => {
    await renderPanel()

    const newCategoryButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('New category')
    )
    await act(async () => {
      newCategoryButton?.click()
    })

    const updateMemory = useMemoryStore.getState().updateMemory as ReturnType<typeof vi.fn>
    const persisted = updateMemory.mock.calls.at(-1)?.[0]
    expect(persisted.categories).toHaveLength(3)
    expect(persisted.categories.at(-1)?.name).toBe('New category')
    // The new category becomes the selected one (its note panel shows the empty state).
    expect(container.textContent).toContain('No notes yet.')
  })

  it('toggles the master switch off without deleting notes', async () => {
    await renderPanel()

    const toggle = container.querySelector('[role="switch"]')
    await act(async () => {
      toggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const updateMemory = useMemoryStore.getState().updateMemory as ReturnType<typeof vi.fn>
    const persisted = updateMemory.mock.calls.at(-1)?.[0]
    expect(persisted.enabled).toBe(false)
    expect(persisted.notes).toHaveLength(1)
    // The disabled hint appears.
    expect(container.textContent).toContain('Memory is off.')
  })

  it('clears all notes with the Clear all action', async () => {
    await renderPanel()

    const clearAll = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Clear all')
    )
    await act(async () => {
      clearAll?.click()
    })

    const updateMemory = useMemoryStore.getState().updateMemory as ReturnType<typeof vi.fn>
    const persisted = updateMemory.mock.calls.at(-1)?.[0]
    expect(persisted.notes).toHaveLength(0)
    expect(persisted.categories).toHaveLength(2)
  })
})
