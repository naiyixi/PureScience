/* Hallmark · pre-emit critique: P5 H5 E5 S5 R5 V5 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertDialog } from 'radix-ui'
import { BookOpenText, ChevronLeft, Pencil, Plus, Trash2 } from 'lucide-react'

import { useLanguage } from '@/i18n'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  dialogDescriptionClassName,
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogTitleClassName
} from '@/components/ui/dialog-chrome'
import { useMemoryStore } from '@/stores/memory-store'
import type { MemoryCategory, MemoryNote, MemorySettings } from '../../../../shared/settings'

// The built-in landing category, present even for a fresh, never-written memory.
const DEFAULT_MEMORY_CATEGORY_NAME = 'About you'
// Matches the reference design: a bounded set of user-created categories keeps the recall prompt
// small and the list scannable.
const MAX_MEMORY_CATEGORIES = 10

// Display name for a memory category. The built-in "About you" category is localized on screen as
// long as the user never renamed it (id + untouched English default => translated label); once
// renamed, the user's own name is authoritative and shown verbatim.
const displayCategoryName = (
  category: { id: string; name: string },
  t: ReturnType<typeof useLanguage>['t']
): string =>
  category.id === 'about-you' && category.name === DEFAULT_MEMORY_CATEGORY_NAME
    ? t('settings.memoryAboutYou')
    : category.name

const createId = (): string =>
  `memory-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

// Normalizes the user's memory: ensures the built-in "About you" category always exists (so notes
// never dangle), drops notes whose category vanished, and keeps everything newest-first.
const normalizeMemory = (memory: MemorySettings | undefined): MemorySettings => {
  if (!memory) {
    return {
      enabled: false,
      categories: [{ id: 'about-you', name: DEFAULT_MEMORY_CATEGORY_NAME, createdAt: Date.now() }],
      notes: []
    }
  }

  const hasDefault = memory.categories.some((category) => category.id === 'about-you')
  const categories = hasDefault
    ? memory.categories
    : [
        { id: 'about-you', name: DEFAULT_MEMORY_CATEGORY_NAME, createdAt: Date.now() },
        ...memory.categories
      ]

  const categoryIds = new Set(categories.map((category) => category.id))
  const notes = memory.notes
    .filter((note) => categoryIds.has(note.categoryId))
    .sort((left, right) => right.updatedAt - left.updatedAt)

  return { enabled: memory.enabled, categories, notes }
}

// The master switch row: On/Off + Clear all, right-aligned above the card like the reference
// design. The panel title lives in the page header, so this row carries only the controls.
const MemoryHeader = ({
  memory,
  onChange
}: {
  memory: MemorySettings
  onChange: (memory: MemorySettings) => void
}): React.JSX.Element => {
  const { t } = useLanguage()

  const toggleEnabled = useCallback((): void => {
    onChange({ ...memory, enabled: !memory.enabled })
  }, [memory, onChange])

  const clearAll = useCallback((): void => {
    onChange({ ...memory, notes: [] })
  }, [memory, onChange])

  return (
    <div className="flex items-center justify-end gap-2">
      <span className="text-[13px] text-text-100">
        {memory.enabled ? t('settings.memoryOn') : t('settings.memoryOff')}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={memory.enabled}
        aria-label={t('settings.memoryEnabled')}
        className={cn(
          'relative h-5 w-9 rounded-full transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
          memory.enabled ? 'bg-accent' : 'bg-bg-200'
        )}
        onClick={toggleEnabled}
      >
        <span
          className={cn(
            'absolute top-0.5 size-4 rounded-full bg-white shadow transition-transform',
            memory.enabled ? 'translate-x-[18px]' : 'translate-x-0.5'
          )}
        />
      </button>
      <button
        type="button"
        data-slot="memory-clear-all"
        className="ml-2 flex items-center gap-1.5 rounded-md px-2 py-1 text-[13px] text-text-300 outline-none hover:bg-bg-200 hover:text-text-100 focus-visible:ring-2 focus-visible:ring-ring/50"
        onClick={clearAll}
      >
        <Trash2 className="size-3.5" aria-hidden="true" />
        {t('settings.memoryClearAll')}
      </button>
    </div>
  )
}

// Left column: category list with per-category note counts, hover actions (rename / delete),
// and the add-category action. The built-in About you category can be renamed but not deleted —
// it is re-created by normalization, so a delete affordance there would be misleading.
const MemoryCategoryList = ({
  memory,
  selectedCategoryId,
  onSelect,
  onAddCategory,
  onRenameCategory,
  onDeleteCategory
}: {
  memory: MemorySettings
  selectedCategoryId: string
  onSelect: (categoryId: string) => void
  onAddCategory: () => void
  onRenameCategory: (categoryId: string, name: string) => void
  onDeleteCategory: (categoryId: string) => void
}): React.JSX.Element => {
  const { t } = useLanguage()
  // Inline rename: the category id being edited and the draft name.
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [categoryPendingDelete, setCategoryPendingDelete] = useState<MemoryCategory | null>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)

  const counts = useMemo(() => {
    const result = new Map<string, number>()
    for (const note of memory.notes) {
      result.set(note.categoryId, (result.get(note.categoryId) ?? 0) + 1)
    }
    return result
  }, [memory.notes])

  const startRename = (category: MemoryCategory): void => {
    setRenamingId(category.id)
    setRenameDraft(displayCategoryName(category, t))
    // Focus after the input renders (the rename row swaps in the input in the same tick).
    requestAnimationFrame(() => renameInputRef.current?.focus())
  }

  const commitRename = (): void => {
    if (renamingId) {
      const name = renameDraft.trim()
      if (name.length > 0) onRenameCategory(renamingId, name)
    }
    setRenamingId(null)
  }

  const noteCountFor = (categoryId: string): number => counts.get(categoryId) ?? 0

  return (
    <div className="flex w-44 shrink-0 flex-col border-r border-border">
      <div className="flex-1 overflow-y-auto p-2">
        {memory.categories.map((category) => {
          const isRenaming = renamingId === category.id
          const isBuiltIn = category.id === 'about-you'
          return (
            <div
              key={category.id}
              className={cn(
                'group flex w-full items-center rounded-md px-2 py-1 text-left text-[12px] outline-none',
                selectedCategoryId === category.id
                  ? 'bg-bg-200 text-text-100'
                  : 'text-text-200 hover:bg-bg-100'
              )}
            >
              {isRenaming ? (
                <input
                  ref={renameInputRef}
                  value={renameDraft}
                  data-slot="memory-category-rename-input"
                  onChange={(event) => setRenameDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') commitRename()
                    if (event.key === 'Escape') setRenamingId(null)
                  }}
                  onBlur={commitRename}
                  className="min-w-0 flex-1 rounded-sm border border-border bg-bg-00 px-1 py-0.5 text-[12px] text-text-100 outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                />
              ) : (
                <>
                  <button
                    type="button"
                    className="min-w-0 flex-1 truncate text-left outline-none"
                    onClick={() => onSelect(category.id)}
                  >
                    {displayCategoryName(category, t)}
                  </button>
                  <span
                    className="ml-1 shrink-0 text-[11px] text-text-300"
                    data-memory-category-count={category.id}
                  >
                    {noteCountFor(category.id)}
                  </span>
                  <span className="ml-1 flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                    <button
                      type="button"
                      data-slot="memory-category-rename"
                      aria-label={t('settings.memoryRenameCategory')}
                      title={t('settings.memoryRenameCategory')}
                      className="rounded-sm p-0.5 text-text-300 outline-none hover:bg-bg-200 hover:text-text-100 focus-visible:ring-2 focus-visible:ring-ring/50"
                      onClick={() => startRename(category)}
                    >
                      <Pencil className="size-3" aria-hidden="true" />
                    </button>
                    {!isBuiltIn ? (
                      <button
                        type="button"
                        data-slot="memory-category-delete"
                        aria-label={t('settings.memoryDeleteCategory')}
                        title={t('settings.memoryDeleteCategory')}
                        className="rounded-sm p-0.5 text-text-300 outline-none hover:bg-danger-000/10 hover:text-danger-000 focus-visible:ring-2 focus-visible:ring-ring/50"
                        onClick={() => setCategoryPendingDelete(category)}
                      >
                        <Trash2 className="size-3" aria-hidden="true" />
                      </button>
                    ) : null}
                  </span>
                </>
              )}
            </div>
          )
        })}
      </div>
      <div className="border-t border-border p-2">
        <button
          type="button"
          className="flex w-full items-center gap-1 rounded-md px-2 py-1.5 text-[12px] font-medium text-text-100 outline-none hover:bg-bg-100 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
          onClick={onAddCategory}
        >
          <Plus className="size-3.5" aria-hidden="true" />
          {t('settings.memoryAddCategory')}
        </button>
      </div>

      <AlertDialog.Root
        open={categoryPendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setCategoryPendingDelete(null)
        }}
      >
        <AlertDialog.Portal>
          <AlertDialog.Overlay className={dialogOverlayClassName} />
          <AlertDialog.Content className={dialogPanelClassName('w-[min(440px,calc(100vw-2rem))]')}>
            <AlertDialog.Title className={dialogTitleClassName}>
              {t('settings.memoryDeleteCategoryTitle').replace(
                '{name}',
                categoryPendingDelete?.name ?? ''
              )}
            </AlertDialog.Title>
            <AlertDialog.Description className={dialogDescriptionClassName}>
              {t('settings.memoryDeleteCategoryDescription').replace(
                '{count}',
                String(categoryPendingDelete ? noteCountFor(categoryPendingDelete.id) : 0)
              )}
            </AlertDialog.Description>
            <div className="mt-6 flex justify-end gap-2">
              <AlertDialog.Cancel asChild>
                <Button type="button" variant="outline">
                  {t('common.cancel')}
                </Button>
              </AlertDialog.Cancel>
              <AlertDialog.Action asChild>
                <Button
                  type="button"
                  variant="destructive"
                  data-slot="memory-category-delete-confirm"
                  onClick={() => {
                    if (categoryPendingDelete) onDeleteCategory(categoryPendingDelete.id)
                  }}
                >
                  {t('common.delete')}
                </Button>
              </AlertDialog.Action>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </div>
  )
}

// Right column in create mode: the full category form — name, save-timing guidance, auto-recall,
// and the bounded-categories usage counter. Mirrors the reference design's New-category page.
const MemoryCategoryForm = ({
  usedCount,
  onCancel,
  onCreate
}: {
  usedCount: number
  onCancel: () => void
  onCreate: (draft: { name: string; prompt?: string; autoRecall: boolean }) => void
}): React.JSX.Element => {
  const { t } = useLanguage()
  const [name, setName] = useState('')
  const [prompt, setPrompt] = useState('')
  const [autoRecall, setAutoRecall] = useState(true)

  const canCreate = name.trim().length > 0 && usedCount < MAX_MEMORY_CATEGORIES

  const create = useCallback((): void => {
    if (!canCreate) return
    const trimmedPrompt = prompt.trim()
    onCreate({
      name: name.trim(),
      prompt: trimmedPrompt.length > 0 ? trimmedPrompt : undefined,
      autoRecall
    })
  }, [autoRecall, canCreate, onCreate, name, prompt])

  return (
    <div data-slot="memory-category-form" className="flex min-w-0 flex-1 flex-col overflow-y-auto">
      <div className="flex items-center gap-1.5 border-b border-border px-4 py-2.5">
        <button
          type="button"
          data-slot="memory-category-form-back"
          className="rounded-md p-1 text-text-300 outline-none hover:bg-bg-200 hover:text-text-100 focus-visible:ring-2 focus-visible:ring-ring/50"
          aria-label={t('settings.memoryBack')}
          onClick={onCancel}
        >
          <ChevronLeft className="size-4" aria-hidden="true" />
        </button>
        <span className="truncate text-[13px] font-medium text-text-100">
          {t('settings.memoryCategoryFormTitle')}
        </span>
      </div>

      <div className="flex-1 space-y-4 p-4">
        <p className="max-w-xl text-[12px] leading-5 text-text-300">
          {t('settings.memoryCategoryFormDescription')}
        </p>

        <div>
          <label
            htmlFor="memory-category-name"
            className="mb-1 block text-[12px] font-medium text-text-100"
          >
            {t('settings.memoryCategoryName')}
          </label>
          <input
            id="memory-category-name"
            data-slot="memory-category-name-input"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={t('settings.memoryCategoryNamePlaceholder')}
            className="w-full rounded-md border border-border bg-bg-00 px-3 py-2 text-[12px] text-text-100 outline-none placeholder:text-text-300 focus-visible:ring-2 focus-visible:ring-ring/50"
          />
        </div>

        <div>
          <label
            htmlFor="memory-category-prompt"
            className="mb-1 block text-[12px] font-medium text-text-100"
          >
            {t('settings.memoryCategoryPrompt')}
          </label>
          <textarea
            id="memory-category-prompt"
            data-slot="memory-category-prompt-input"
            value={prompt}
            rows={3}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder={t('settings.memoryCategoryPromptPlaceholder')}
            className="w-full resize-y rounded-md border border-border bg-bg-00 px-3 py-2 text-[12px] leading-5 text-text-100 outline-none placeholder:text-text-300 focus-visible:ring-2 focus-visible:ring-ring/50"
          />
        </div>

        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="text-[13px] font-medium text-text-100">
              {t('settings.memoryAutoRecall')}
            </div>
            <div className="mt-0.5 text-[12px] leading-5 text-text-300">
              {t('settings.memoryAutoRecallHint')}
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={autoRecall}
            aria-label={t('settings.memoryAutoRecall')}
            data-slot="memory-category-auto-recall"
            className={cn(
              'relative h-5 w-9 shrink-0 rounded-full transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
              autoRecall ? 'bg-accent' : 'bg-bg-200'
            )}
            onClick={() => setAutoRecall((value) => !value)}
          >
            <span
              className={cn(
                'absolute top-0.5 size-4 rounded-full bg-white shadow transition-transform',
                autoRecall ? 'translate-x-[18px]' : 'translate-x-0.5'
              )}
            />
          </button>
        </div>
      </div>

      <div className="flex items-center justify-between border-t border-border px-4 py-3">
        <span className="text-[12px] text-text-300" data-slot="memory-category-usage">
          {usedCount} / {MAX_MEMORY_CATEGORIES} {t('settings.memoryCategoryUsage')}
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="rounded-md px-3 py-1.5 text-[12px] text-text-200 outline-none hover:bg-bg-200 hover:text-text-100 focus-visible:ring-2 focus-visible:ring-ring/50"
            onClick={onCancel}
          >
            {t('settings.memoryCancel')}
          </button>
          <button
            type="button"
            data-slot="memory-category-create"
            disabled={!canCreate}
            className="rounded-md bg-accent px-3 py-1.5 text-[12px] text-white outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-40"
            onClick={create}
          >
            {t('settings.memoryCreate')}
          </button>
        </div>
      </div>
    </div>
  )
}

// Right column in notes mode: an always-present composer ("Add a note…") plus the saved notes.
// The composer is the primary writing surface — typing + Enter saves, so a note never exists as an
// unreachable empty card. Saved notes stay inline-editable with a hover delete.
const MemoryNoteList = ({
  category,
  notes,
  onSubmitNote,
  onUpdateNote,
  onDeleteNote
}: {
  category: MemoryCategory | undefined
  notes: MemoryNote[]
  onSubmitNote: (text: string) => void
  onUpdateNote: (note: MemoryNote, text: string) => void
  onDeleteNote: (noteId: string) => void
}): React.JSX.Element => {
  const { t } = useLanguage()
  const [draft, setDraft] = useState('')
  const composerRef = useRef<HTMLInputElement>(null)

  if (!category) {
    return (
      <div className="flex flex-1 items-center justify-center text-[12px] text-text-300">
        {t('settings.memoryEmpty')}
      </div>
    )
  }

  const submitDraft = (): void => {
    const text = draft.trim()
    if (text.length === 0) return
    onSubmitNote(text)
    setDraft('')
    composerRef.current?.focus()
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
        <span className="truncate text-[13px] font-medium text-text-100">
          {displayCategoryName(category, t)}
        </span>
        <button
          type="button"
          className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[12px] text-text-200 outline-none hover:bg-bg-200 hover:text-text-100 focus-visible:ring-2 focus-visible:ring-ring/50"
          onClick={() => composerRef.current?.focus()}
        >
          <Plus className="size-3.5" aria-hidden="true" />
          {t('settings.memoryAddNote')}
        </button>
      </div>
      <div className="flex-1 space-y-2 overflow-y-auto p-4">
        <input
          ref={composerRef}
          data-slot="memory-note-composer"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault()
              submitDraft()
            }
          }}
          placeholder={t('settings.memoryNoteComposerPlaceholder')}
          aria-label={t('settings.memoryAddNote')}
          className="w-full rounded-lg border border-border bg-bg-00 px-3 py-2 text-[12px] text-text-100 outline-none placeholder:text-text-300 focus-visible:ring-2 focus-visible:ring-ring/50"
        />
        {notes.length === 0 ? (
          <div className="py-8 text-center text-[12px] text-text-300">
            {t('settings.memoryNoNotes')}
          </div>
        ) : (
          notes.map((note) => (
            <div
              key={note.id}
              className="group rounded-lg border border-border bg-bg-00 p-2.5 transition-colors hover:border-bg-200"
              data-memory-note={note.id}
            >
              <textarea
                value={note.text}
                rows={Math.max(2, Math.min(6, note.text.split('\n').length))}
                placeholder={t('settings.memoryNotePlaceholder')}
                className="min-h-0 w-full resize-y bg-transparent text-[12px] leading-5 text-text-100 outline-none placeholder:text-text-300"
                onChange={(event) => onUpdateNote(note, event.target.value)}
              />
              {(note.evidence || note.supersededBy) && (
                <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-text-400">
                  {note.supersededBy && (
                    <span
                      className="rounded bg-bg-200 px-1 py-0.5 font-medium text-text-300"
                      data-testid="memory-note-superseded"
                      title={t('settings.memorySupersededTooltip')}
                    >
                      {t('settings.memorySuperseded')}
                    </span>
                  )}
                  {note.evidence && (
                    <span data-testid="memory-note-evidence" className="truncate">
                      {t('settings.memoryEvidence')}: {note.evidence}
                    </span>
                  )}
                </div>
              )}
              <div className="mt-1 flex items-center justify-end">
                <button
                  type="button"
                  className="rounded-sm p-1 text-text-300 opacity-0 outline-none transition-opacity group-hover:opacity-100 hover:bg-danger-000/10 hover:text-danger-000 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/50"
                  onClick={() => onDeleteNote(note.id)}
                  aria-label={t('settings.memoryDeleteNote')}
                  title={t('settings.memoryDeleteNote')}
                >
                  <Trash2 className="size-3.5" aria-hidden="true" />
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

// Editable memory: categories + notes + master switch. Structured memory with categories, notes, and a master switch
// (About you / custom categories, On/Off, Clear all, bounded category count, auto-recall). Notes
// are user-authored plain text used by the app to recall preferences across sessions.
export const MemoryPanel = (): React.JSX.Element => {
  const { t } = useLanguage()
  const memory = useMemoryStore((state) => state.memory)
  const isLoading = useMemoryStore((state) => state.isLoading)
  const loadMemory = useMemoryStore((state) => state.loadMemory)
  const updateMemory = useMemoryStore((state) => state.updateMemory)
  const [selectedCategoryId, setSelectedCategoryId] = useState<string>('about-you')
  const [isCreatingCategory, setIsCreatingCategory] = useState(false)

  // Load once on first open; a later settings snapshot does not carry memory (independent store).
  useEffect(() => {
    void loadMemory()
  }, [loadMemory])

  const normalized = useMemo(() => normalizeMemory(memory), [memory])

  const persist = useCallback(
    (next: MemorySettings): void => {
      setSelectedCategoryId((selected) =>
        next.categories.some((category) => category.id === selected) ? selected : 'about-you'
      )
      void updateMemory(next).catch(() => undefined)
    },
    [updateMemory]
  )

  // Submits the category form: persists the new category (with its prompt/auto-recall) and selects it.
  const createCategory = useCallback(
    (draft: { name: string; prompt?: string; autoRecall: boolean }): void => {
      const now = Date.now()
      const category: MemoryCategory = {
        id: createId(),
        name: draft.name,
        createdAt: now,
        ...(draft.prompt !== undefined ? { prompt: draft.prompt } : {}),
        autoRecall: draft.autoRecall
      }
      persist({ ...normalized, categories: [...normalized.categories, category] })
      setSelectedCategoryId(category.id)
      setIsCreatingCategory(false)
    },
    [normalized, persist]
  )

  // The composer is the only note-creation path: a note is born with its text, so the sanitizer
  // never sees a dangling empty card and the note list never flashes.
  const addNote = useCallback(
    (text: string): void => {
      const now = Date.now()
      const note: MemoryNote = {
        id: createId(),
        categoryId: selectedCategoryId,
        text,
        createdAt: now,
        updatedAt: now
      }
      persist({ ...normalized, notes: [...normalized.notes, note] })
    },
    [normalized, persist, selectedCategoryId]
  )

  const updateNote = useCallback(
    (note: MemoryNote, text: string): void => {
      persist({
        ...normalized,
        notes: normalized.notes.map((candidate) =>
          candidate.id === note.id ? { ...candidate, text, updatedAt: Date.now() } : candidate
        )
      })
    },
    [normalized, persist]
  )

  const deleteNote = useCallback(
    (noteId: string): void => {
      persist({ ...normalized, notes: normalized.notes.filter((note) => note.id !== noteId) })
    },
    [normalized, persist]
  )

  // Renames a category in place (trimmed, non-empty only); the About you built-in is renamable.
  const renameCategory = useCallback(
    (categoryId: string, name: string): void => {
      persist({
        ...normalized,
        categories: normalized.categories.map((category) =>
          category.id === categoryId ? { ...category, name } : category
        )
      })
    },
    [normalized, persist]
  )

  // Deletes a category and its notes. The About you built-in never reaches here (no delete
  // affordance), but the guard keeps a stale call from collapsing the default category.
  const deleteCategory = useCallback(
    (categoryId: string): void => {
      if (categoryId === 'about-you') return
      persist({
        ...normalized,
        categories: normalized.categories.filter((category) => category.id !== categoryId),
        notes: normalized.notes.filter((note) => note.categoryId !== categoryId)
      })
    },
    [normalized, persist]
  )

  const selectedCategory = normalized.categories.find(
    (category) => category.id === selectedCategoryId
  )
  const selectedNotes = normalized.notes.filter((note) => note.categoryId === selectedCategoryId)

  return (
    <div
      data-slot="memory-panel"
      className="flex h-full min-h-0 flex-col overflow-hidden"
      data-memory-enabled={normalized.enabled ? 'true' : 'false'}
    >
      <div className="flex items-start gap-2 px-5 pt-5">
        <BookOpenText className="mt-0.5 size-4 shrink-0 text-text-300" aria-hidden="true" />
        <div>
          <h2 className="text-base font-medium text-foreground">{t('settings.memoryTitle')}</h2>
          <p className="mt-0.5 max-w-2xl text-sm leading-5 text-muted-foreground">
            {t('settings.memoryDescription')}
          </p>
        </div>
      </div>

      {!normalized.enabled ? (
        <div className="mx-5 mt-4 rounded-lg border border-border bg-bg-00 px-3 py-2.5 text-[12px] leading-5 text-text-300">
          <Pencil className="mr-1.5 inline size-3.5 text-text-300" aria-hidden="true" />
          {t('settings.memoryDisabledHint')}
        </div>
      ) : null}

      {isLoading && !memory ? (
        <div className="mx-5 mt-4 rounded-lg border border-border bg-bg-00 px-3 py-2.5 text-[12px] leading-5 text-text-300">
          {t('settings.memoryLoading')}
        </div>
      ) : null}

      <div className="mt-4 px-5">
        <MemoryHeader memory={normalized} onChange={persist} />
      </div>

      <div className="mx-5 mb-5 flex min-h-0 flex-1 overflow-hidden rounded-lg border border-border bg-bg-10">
        <MemoryCategoryList
          memory={normalized}
          selectedCategoryId={selectedCategoryId}
          onSelect={(categoryId) => {
            setSelectedCategoryId(categoryId)
            setIsCreatingCategory(false)
          }}
          onAddCategory={() => setIsCreatingCategory(true)}
          onRenameCategory={renameCategory}
          onDeleteCategory={deleteCategory}
        />
        {isCreatingCategory ? (
          <MemoryCategoryForm
            usedCount={normalized.categories.length}
            onCancel={() => setIsCreatingCategory(false)}
            onCreate={createCategory}
          />
        ) : (
          <MemoryNoteList
            category={selectedCategory}
            notes={selectedNotes}
            onSubmitNote={addNote}
            onUpdateNote={updateNote}
            onDeleteNote={deleteNote}
          />
        )}
      </div>
    </div>
  )
}
