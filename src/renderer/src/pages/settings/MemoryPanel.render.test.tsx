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
      'settings.memoryOn': 'On',
      'settings.memoryOff': 'Off',
      'settings.memoryClearAll': 'Clear all',
      'settings.memoryAddCategory': 'New category',
      'settings.memoryEmpty': 'Select a category',
      'settings.memoryAddNote': 'Add note',
      'settings.memoryNoNotes': 'No notes yet.',
      'settings.memoryNotePlaceholder': 'Write…',
      'settings.memoryNoteComposerPlaceholder': 'Add a note…',
      'settings.memoryDeleteNote': 'Delete note',
      'settings.memoryDisabledHint': 'Memory is off.',
      'settings.memoryBack': 'Back',
      'settings.memoryCancel': 'Cancel',
      'settings.memoryCreate': 'Create',
      'settings.memoryCategoryFormTitle': 'New category',
      'settings.memoryCategoryFormDescription': 'Categories group notes.',
      'settings.memoryCategoryName': 'Name',
      'settings.memoryCategoryNamePlaceholder': 'e.g. footguns',
      'settings.memoryCategoryPrompt': 'When should the app save a note here?',
      'settings.memoryCategoryPromptPlaceholder': 'Save anything that costs >10 minutes',
      'settings.memoryAutoRecall': 'Auto-recall',
      'settings.memoryAutoRecallHint': 'Off = saved and searchable, never auto-injected',
      'settings.memoryCategoryUsage': 'categories used',
      'settings.memoryRenameCategory': 'Rename category',
      'settings.memoryDeleteCategory': 'Delete category',
      'settings.memoryDeleteCategoryTitle': 'Delete "{name}"?',
      'settings.memoryDeleteCategoryDescription': 'This deletes the category and its {count} note(s).'
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

// Sets a controlled input/textarea value the way React's runtime expects (native setter + input
// event), then flushes — the shared pattern used by the other settings-panel render tests.
const typeInto = async (element: HTMLInputElement | HTMLTextAreaElement, text: string): Promise<void> => {
  const prototype = element instanceof HTMLTextAreaElement
    ? window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement.prototype
  const valueSetter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
  await act(async () => {
    valueSetter?.call(element, text)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
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

  const composer = (): HTMLInputElement =>
    document.body.querySelector<HTMLInputElement>('[data-slot="memory-note-composer"]')!

  it('renders categories, notes, the master switch, and the note composer', async () => {
    await renderPanel()

    expect(container.querySelector('[data-memory-enabled]')?.getAttribute('data-memory-enabled')).toBe('true')
    expect(container.textContent).toContain('About you')
    expect(container.textContent).toContain('Research')
    expect(container.textContent).toContain('Prefers concise answers')
    expect(container.textContent).toContain('On')
    expect(composer()).toBeTruthy()
  })

  it('saves a typed note via the composer on Enter and clears the draft', async () => {
    await renderPanel()
    await typeInto(composer(), 'Uses npmmirror for installs')
    await act(async () => {
      composer().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })

    const updateMemory = useMemoryStore.getState().updateMemory as ReturnType<typeof vi.fn>
    const persisted = updateMemory.mock.calls.at(-1)?.[0]
    expect(persisted.notes).toHaveLength(2)
    // The panel appends before persist; newest-first ordering happens on read.
    expect(persisted.notes.at(-1).text).toBe('Uses npmmirror for installs')
    expect(persisted.notes.at(-1).categoryId).toBe('about-you')
    // The composer resets after submit.
    expect(composer().value).toBe('')
  })

  it('does not persist an empty composer submit', async () => {
    await renderPanel()
    await act(async () => {
      composer().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })

    const updateMemory = useMemoryStore.getState().updateMemory as ReturnType<typeof vi.fn>
    expect(updateMemory).not.toHaveBeenCalled()
  })

  it('keeps editing an existing note inline', async () => {
    await renderPanel()

    const noteTextarea = container.querySelector<HTMLTextAreaElement>('[data-memory-note="note-1"] textarea')!
    await typeInto(noteTextarea, 'Prefers concise answers and zh output')

    const updateMemory = useMemoryStore.getState().updateMemory as ReturnType<typeof vi.fn>
    const persisted = updateMemory.mock.calls.at(-1)?.[0]
    expect(persisted.notes[0].text).toBe('Prefers concise answers and zh output')
  })

  it('creates a category through the form with prompt and auto-recall', async () => {
    await renderPanel()

    const newCategoryButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('New category')
    )
    await act(async () => {
      newCategoryButton?.click()
    })

    // The form opens without persisting anything yet.
    const form = document.body.querySelector('[data-slot="memory-category-form"]')
    expect(form).toBeTruthy()
    let updateMemory = useMemoryStore.getState().updateMemory as ReturnType<typeof vi.fn>
    expect(updateMemory).not.toHaveBeenCalled()

    await typeInto(
      document.body.querySelector<HTMLInputElement>('[data-slot="memory-category-name-input"]')!,
      'Footguns'
    )
    await typeInto(
      document.body.querySelector<HTMLTextAreaElement>('[data-slot="memory-category-prompt-input"]')!,
      'Anything that costs >10 minutes to debug'
    )
    await act(async () => {
      document
        .body.querySelector<HTMLButtonElement>('[data-slot="memory-category-auto-recall"]')!
        .click()
    })
    await act(async () => {
      document.body.querySelector<HTMLButtonElement>('[data-slot="memory-category-create"]')!.click()
    })

    updateMemory = useMemoryStore.getState().updateMemory as ReturnType<typeof vi.fn>
    const persisted = updateMemory.mock.calls.at(-1)?.[0]
    expect(persisted.categories).toHaveLength(3)
    expect(persisted.categories.at(-1)).toMatchObject({
      name: 'Footguns',
      prompt: 'Anything that costs >10 minutes to debug',
      autoRecall: false
    })
    // The form closed and the new (empty) category is selected.
    expect(document.body.querySelector('[data-slot="memory-category-form"]')).toBeNull()
    expect(container.textContent).toContain('No notes yet.')
  })

  it('disables Create until the category has a name, and Cancel discards', async () => {
    await renderPanel()

    const newCategoryButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('New category')
    )
    await act(async () => {
      newCategoryButton?.click()
    })

    const createButton = document.body.querySelector<HTMLButtonElement>(
      '[data-slot="memory-category-create"]'
    )!
    expect(createButton.disabled).toBe(true)

    await typeInto(
      document.body.querySelector<HTMLInputElement>('[data-slot="memory-category-name-input"]')!,
      'Experiment results'
    )
    expect(createButton.disabled).toBe(false)

    await act(async () => {
      document
        .body.querySelector<HTMLButtonElement>('[data-slot="memory-category-form-back"]')!
        .click()
    })
    const updateMemory = useMemoryStore.getState().updateMemory as ReturnType<typeof vi.fn>
    expect(updateMemory).not.toHaveBeenCalled()
    expect(document.body.querySelector('[data-slot="memory-category-form"]')).toBeNull()
  })

  it('shows the usage counter in the category form', async () => {
    await renderPanel()

    const newCategoryButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('New category')
    )
    await act(async () => {
      newCategoryButton?.click()
    })

    const usage = document.body.querySelector('[data-slot="memory-category-usage"]')
    expect(usage?.textContent).toContain('2')
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
    // The switch label flips to Off.
    expect(container.textContent).toContain('Off')
    expect(container.textContent).toContain('Memory is off.')
  })

  it('clears all notes with the Clear all action', async () => {
    await renderPanel()

    const clearAll = document.body.querySelector<HTMLButtonElement>('[data-slot="memory-clear-all"]')
    await act(async () => {
      clearAll?.click()
    })

    const updateMemory = useMemoryStore.getState().updateMemory as ReturnType<typeof vi.fn>
    const persisted = updateMemory.mock.calls.at(-1)?.[0]
    expect(persisted.notes).toHaveLength(0)
    expect(persisted.categories).toHaveLength(2)
  })

  it('renames a category via the inline rename input', async () => {
    await renderPanel()

    // Fixture categories are [about-you, research]; the second rename action belongs to research.
    const renameButtons = document.body.querySelectorAll<HTMLButtonElement>(
      '[data-slot="memory-category-rename"]'
    )
    expect(renameButtons.length).toBeGreaterThanOrEqual(2)
    await act(async () => {
      renameButtons[1]?.click()
    })

    const renameInput = document.body.querySelector<HTMLInputElement>(
      '[data-slot="memory-category-rename-input"]'
    )
    expect(renameInput).toBeTruthy()
    await typeInto(renameInput!, 'Lab notes')
    await act(async () => {
      renameInput!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })

    const updateMemory = useMemoryStore.getState().updateMemory as ReturnType<typeof vi.fn>
    const persisted = updateMemory.mock.calls.at(-1)?.[0]
    expect(persisted.categories.find((category: { id: string }) => category.id === 'research')?.name).toBe('Lab notes')
  })

  it('deletes a custom category and its notes after confirmation', async () => {
    useMemoryStore.setState({
      memory: {
        ...memoryFixture,
        notes: [
          ...memoryFixture.notes,
          {
            id: 'note-2',
            categoryId: 'research',
            text: 'Research note',
            createdAt: 2000,
            updatedAt: 2001
          }
        ]
      }
    })
    await renderPanel()

    const deleteButton = document.body.querySelector<HTMLButtonElement>(
      '[data-slot="memory-category-delete"]'
    )
    await act(async () => {
      deleteButton?.click()
    })

    // The confirmation dialog appears; confirm it.
    const confirmButton = document.body.querySelector<HTMLButtonElement>(
      '[data-slot="memory-category-delete-confirm"]'
    )
    expect(confirmButton).toBeTruthy()
    await act(async () => {
      confirmButton?.click()
    })

    const updateMemory = useMemoryStore.getState().updateMemory as ReturnType<typeof vi.fn>
    const persisted = updateMemory.mock.calls.at(-1)?.[0]
    expect(persisted.categories).toHaveLength(1)
    expect(persisted.categories[0].id).toBe('about-you')
    // Notes under the deleted category are removed; the About you note survives.
    expect(persisted.notes).toHaveLength(1)
    expect(persisted.notes[0].id).toBe('note-1')
  })

  it('does not offer a delete action for the built-in About you category', async () => {
    await renderPanel()

    // Only one delete affordance exists in the fixture (for "Research"); About you has none.
    const deleteButtons = document.body.querySelectorAll('[data-slot="memory-category-delete"]')
    expect(deleteButtons).toHaveLength(1)
  })

  it('renders the evidence source on notes that carry provenance', async () => {
    useMemoryStore.setState({
      memory: {
        enabled: true,
        categories: [{ id: 'about-you', name: 'About you', createdAt: 1000 }],
        notes: [
          {
            id: 'note-ev',
            categoryId: 'about-you',
            text: 'T790M is the resistance driver',
            createdAt: 1,
            updatedAt: 1,
            evidence: 'from variant analysis session'
          }
        ]
      },
      isLoading: false
    })
    await renderPanel()

    const evidence = container.querySelector('[data-testid="memory-note-evidence"]')
    expect(evidence).not.toBeNull()
    expect(evidence!.textContent).toContain('from variant analysis session')
  })

  it('renders the superseded marker on notes replaced by a newer note', async () => {
    useMemoryStore.setState({
      memory: {
        enabled: true,
        categories: [{ id: 'about-you', name: 'About you', createdAt: 1000 }],
        notes: [
          {
            id: 'note-old',
            categoryId: 'about-you',
            text: 'Old preference',
            createdAt: 1,
            updatedAt: 1,
            supersededBy: 'note-new'
          },
          {
            id: 'note-new',
            categoryId: 'about-you',
            text: 'New preference',
            createdAt: 2,
            updatedAt: 2
          }
        ]
      },
      isLoading: false
    })
    await renderPanel()

    const marker = container.querySelector('[data-testid="memory-note-superseded"]')
    expect(marker).not.toBeNull()
    // The t() shim in jsdom returns the raw key; assert on the marker's presence + data attribute.
    expect(marker!.getAttribute('data-testid')).toBe('memory-note-superseded')
  })
})
