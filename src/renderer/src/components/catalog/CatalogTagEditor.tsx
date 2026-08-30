import { Plus, Tag as TagIcon, X } from 'lucide-react'
import { useState } from 'react'

import { useLanguage } from '@/i18n'
import { useCatalogTagsStore } from '@/stores/catalog-tags-store'

type CatalogTagEditorProps = {
  resourceId: string
  // Localized label for the add-tag button, e.g. `t('settings.addTag')`.
  addLabel: string
  // Localized label for the tags group, e.g. `t('settings.tags')`.
  tagsLabel: string
  // Localized placeholder for the tag input.
  placeholder?: string
}

// Inline tag chips + add/remove editor shared by the skills / connectors / specialists
// catalogs. Tags are stored renderer-local in the catalog tags store.
const CatalogTagEditor = ({
  resourceId,
  addLabel,
  tagsLabel,
  placeholder
}: CatalogTagEditorProps): React.JSX.Element => {
  const { t } = useLanguage()
  const tags = useCatalogTagsStore((state) => state.entries[resourceId]?.tags) ?? []
  const addTag = useCatalogTagsStore((state) => state.addTag)
  const removeTag = useCatalogTagsStore((state) => state.removeTag)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')

  const commit = (): void => {
    const value = draft.trim()
    if (value.length > 0) {
      addTag(resourceId, value)
      setDraft('')
    } else {
      setEditing(false)
    }
  }

  return (
    <div
      data-testid="catalog-tag-editor"
      className="flex min-w-0 items-center gap-1"
      aria-label={tagsLabel}
    >
      {tags.map((tag) => (
        <span
          key={tag}
          data-testid="catalog-tag"
          className="inline-flex max-w-28 items-center gap-0.5 rounded-full border border-border-200 bg-bg-100 px-2 py-0.5 text-[11px] text-foreground/80"
        >
          <span className="truncate">{tag}</span>
          <button
            type="button"
            aria-label={`${t('settings.removeTag')} ${tag}`}
            onClick={() => removeTag(resourceId, tag)}
            className="rounded-full p-0.5 text-muted-foreground hover:text-foreground"
          >
            <X className="size-3" aria-hidden="true" />
          </button>
        </span>
      ))}
      {editing ? (
        <input
          data-testid="catalog-tag-input"
          autoFocus
          type="text"
          value={draft}
          placeholder={placeholder}
          maxLength={24}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              commit()
            } else if (event.key === 'Escape') {
              setEditing(false)
              setDraft('')
            }
          }}
          onBlur={commit}
          className="w-24 rounded-md border border-border bg-background px-2 py-0.5 text-[11px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        />
      ) : (
        <button
          type="button"
          data-testid="catalog-tag-add"
          aria-label={addLabel}
          onClick={() => setEditing(true)}
          className="inline-flex items-center gap-0.5 rounded-full border border-dashed border-border-300 px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:border-border-400 hover:text-foreground"
        >
          <Plus className="size-3" aria-hidden="true" />
          <TagIcon className="size-3" aria-hidden="true" />
        </button>
      )}
    </div>
  )
}

export { CatalogTagEditor }
