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
      'settings.memoryCategoryUsage': 'categories used'
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
})
