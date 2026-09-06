import { Pencil, Plus, Tag as TagIcon, Trash2, X } from 'lucide-react'
import { useMemo, useState } from 'react'

import { useLanguage, type TranslationKey } from '@/i18n'
import {
  MAX_TAG_LENGTH,
  selectTagSummaries,
  useCatalogTagsStore
} from '@/stores/catalog-tags-store'
import {
  useCatalogTagsCounts,
  resolveCatalogResourceName,
  type CatalogTagResource
} from './tags-catalog-lookup'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { SettingsSection } from './SettingsLayout'

type TagsPanelProps = {
  onOpenResource: (resource: CatalogTagResource) => void
}

// Settings -> Tags: master-detail management of the cross-resource catalog tags shared by
// Skills, Connectors, and Specialists. The left column lists every tag with its resource count
// (create/rename/delete); the right column shows the resources carrying the selected tag and
// navigates to their detail pages.
const TagsPanel = ({ onOpenResource }: TagsPanelProps): React.JSX.Element => {
  const { t } = useLanguage()
  const entries = useCatalogTagsStore((state) => state.entries)
  const standalone = useCatalogTagsStore((state) => state.standalone)
  const deleteTag = useCatalogTagsStore((state) => state.deleteTag)
  const renameTag = useCatalogTagsStore((state) => state.renameTag)
  const createStandaloneTag = useCatalogTagsStore((state) => state.createStandaloneTag)
  const summaries = useMemo(() => selectTagSummaries(entries, standalone), [entries, standalone])
  const [selectedTag, setSelectedTag] = useState<string | undefined>(undefined)
  const [creating, setCreating] = useState(false)
  const [draft, setDraft] = useState('')
  const [renamingTag, setRenamingTag] = useState<string | undefined>(undefined)
  const [renameDraft, setRenameDraft] = useState('')
  const resources = useCatalogTagsCounts(selectedTag)

  const commitCreate = (): void => {
    const value = draft.trim()
    if (value.length === 0) {
      setCreating(false)
      setDraft('')
      return
    }
    const key = value.toLowerCase()
    const existing = summaries.find((summary) => summary.name === key)
    if (existing) {
      setSelectedTag(existing.name)
    } else {
      // Persist a zero-resource tag so users can build a vocabulary up front; the right column
      // then shows the "no resources yet" empty state instead of silently discarding the name.
      createStandaloneTag(value)
      setSelectedTag(key)
    }
    setCreating(false)
    setDraft('')
  }

  const commitRename = (): void => {
    if (!renamingTag) return
    const value = renameDraft.trim()
    if (value.length > 0 && value.toLowerCase() !== renamingTag.toLowerCase()) {
      renameTag(renamingTag, value)
      setSelectedTag(value.toLowerCase())
    }
    setRenamingTag(undefined)
    setRenameDraft('')
  }

  const confirmDelete = (tag: string): void => {
    deleteTag(tag)
    if (selectedTag?.toLowerCase() === tag.toLowerCase()) setSelectedTag(undefined)
  }

  return (
    <div className="grid h-full min-h-0 grid-cols-[220px_minmax(0,1fr)] p-5 pl-0">
      {/* Left: tag list */}
      <div className="min-h-0 overflow-y-auto border-r border-border p-3 pl-5">
        <SettingsSection
          title={t('settings.tags')}
          description={t('settings.tagsManagerDescription')}
          className="mb-3"
        />
        <ul className="flex flex-col gap-0.5" data-testid="tags-list">
          {summaries.map((summary) => {
            const isActive = selectedTag?.toLowerCase() === summary.name.toLowerCase()
            const isRenaming = renamingTag?.toLowerCase() === summary.name.toLowerCase()
            return (
              <li key={summary.name}>
                {isRenaming ? (
                  <div className="flex items-center gap-1 px-1 py-0.5">
                    <Input
                      autoFocus
                      value={renameDraft}
                      maxLength={MAX_TAG_LENGTH}
                      onChange={(event) => setRenameDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') commitRename()
                        else if (event.key === 'Escape') setRenamingTag(undefined)
                      }}
                      className="h-7 text-sm"
                    />
                    <Button type="button" variant="outline" size="sm" onClick={commitRename}>
                      {t('common.save')}
                    </Button>
                  </div>
                ) : (
                  <div
                    className={cn(
                      'group flex h-8 w-full cursor-pointer items-center gap-2 rounded-lg px-2 text-left text-sm transition-colors',
                      isActive
                        ? 'bg-primary/10 font-medium text-foreground'
                        : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                    )}
                    onClick={() => setSelectedTag(summary.name)}
                  >
                    <TagIcon
                      className={cn(
                        'size-3.5 shrink-0',
                        isActive ? 'text-primary' : 'text-muted-foreground'
                      )}
                      aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1 truncate">{summary.name}</span>
                    <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                      {summary.resourceCount}
                    </span>
                    <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
                      <button
                        type="button"
                        aria-label={`${t('settings.renameTag')} ${summary.name}`}
                        onClick={(event) => {
                          event.stopPropagation()
                          setRenamingTag(summary.name)
                          setRenameDraft(summary.name)
                        }}
                        className="rounded p-0.5 text-muted-foreground hover:text-foreground"
                      >
                        <Pencil className="size-3" aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        aria-label={`${t('settings.deleteTag')} ${summary.name}`}
                        onClick={(event) => {
                          event.stopPropagation()
                          confirmDelete(summary.name)
                        }}
                        className="rounded p-0.5 text-muted-foreground hover:text-danger-000"
                      >
                        <Trash2 className="size-3" aria-hidden="true" />
                      </button>
                    </span>
                  </div>
                )}
              </li>
            )
          })}
          {creating ? (
            <li>
              <div className="flex items-center gap-1 px-1 py-0.5">
                <Input
                  autoFocus
                  value={draft}
                  maxLength={MAX_TAG_LENGTH}
                  placeholder={t('settings.tagNamePlaceholder')}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') commitCreate()
                    else if (event.key === 'Escape') setCreating(false)
                  }}
                  className="h-7 text-sm"
                />
                <Button type="button" variant="outline" size="sm" onClick={commitCreate}>
                  {t('common.save')}
                </Button>
              </div>
            </li>
          ) : (
            <li>
              <button
                type="button"
                onClick={() => setCreating(true)}
                className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <Plus className="size-3.5" aria-hidden="true" />
                {t('settings.newTag')}
              </button>
            </li>
          )}
        </ul>
      </div>

      {/* Right: resources carrying the selected tag */}
      <div className="min-h-0 overflow-y-auto p-4">
        {!selectedTag ? (
          <div className="grid h-full place-items-center text-center">
            <div>
              <TagIcon className="mx-auto size-6 text-text-300" aria-hidden="true" />
              <p className="mt-2 text-sm text-muted-foreground">{t('settings.selectTagHint')}</p>
            </div>
          </div>
        ) : (
          <div>
            <div className="mb-3 flex items-center justify-between">
              <h3 className="flex items-center gap-2 text-base font-semibold text-foreground">
                <TagIcon className="size-4 text-primary" aria-hidden="true" />
                {selectedTag}
                <span className="text-xs font-normal text-muted-foreground">
                  {resources.length} {t('settings.taggedResources')}
                </span>
              </h3>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={t('common.dismiss')}
                onClick={() => setSelectedTag(undefined)}
              >
                <X className="size-4" aria-hidden="true" />
              </Button>
            </div>
            {resources.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('settings.tagNoResources')}</p>
            ) : (
              <ul className="flex flex-col gap-0.5" data-testid="tag-resources">
                {resources.map((resource) => (
                  <li key={`${resource.kind}:${resource.id}`}>
                    <button
                      type="button"
                      onClick={() => onOpenResource(resource)}
                      className="flex h-9 w-full items-center gap-2 rounded-lg px-2 text-left text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
                    >
                      <span className="min-w-0 flex-1 truncate">
                        {resolveCatalogResourceName(resource)}
                      </span>
                      <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                        {t(resourceKindLabel(resource.kind))}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

const resourceKindLabel = (kind: CatalogTagResource['kind']): TranslationKey => {
  switch (kind) {
    case 'skill':
      return 'settings.skills'
    case 'connector':
      return 'settings.connectors'
    case 'specialist':
      return 'settings.specialists'
  }
}

export { TagsPanel }
