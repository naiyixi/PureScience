import { Star } from 'lucide-react'

import { useLanguage } from '@/i18n'
import { cn } from '@/lib/utils'
import { useCatalogTagsStore } from '@/stores/catalog-tags-store'

type CatalogFilterChipsProps = {
  // Resource ids of the currently visible (pre-filter) rows — used to collect the tags
  // that exist in this catalog view.
  resourceIds: readonly string[]
  showFavorites: boolean
  activeTags: readonly string[]
  onToggleFavorites: () => void
  onToggleTag: (tag: string) => void
  onClear: () => void
}

const chipClassName = (active: boolean): string =>
  cn(
    'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition-colors',
    active
      ? 'border-amber-500/50 bg-amber-500/10 text-amber-600'
      : 'border-border-200 bg-bg-100 text-muted-foreground hover:border-border-300 hover:text-foreground'
  )

// Filter chips shared by the skills / connectors / specialists catalogs: an "All" reset,
// a Favorites chip and one chip per tag present in the current view. Tag chips combine
// with Favorites (AND semantics); clicking the active tag removes it.
const CatalogFilterChips = ({
  resourceIds,
  showFavorites,
  activeTags,
  onToggleFavorites,
  onToggleTag,
  onClear
}: CatalogFilterChipsProps): React.JSX.Element => {
  const { t } = useLanguage()
  const entries = useCatalogTagsStore((state) => state.entries)

  const availableTags = Array.from(
    new Map(
      resourceIds
        .flatMap((resourceId) => entries[resourceId]?.tags ?? [])
        .map((tag) => [tag.toLowerCase(), tag])
    ).values()
  ).sort((a, b) => a.localeCompare(b))

  const nothingActive = !showFavorites && activeTags.length === 0

  return (
    <div
      data-testid="catalog-filter-chips"
      className="flex flex-wrap items-center gap-1.5"
      aria-label={t('settings.tags')}
    >
      <button
        type="button"
        data-testid="catalog-filter-all"
        className={chipClassName(nothingActive)}
        onClick={onClear}
      >
        {t('settings.all')}
      </button>
      <button
        type="button"
        data-testid="catalog-filter-favorites"
        aria-pressed={showFavorites}
        className={chipClassName(showFavorites)}
        onClick={onToggleFavorites}
      >
        <Star
          className={cn('size-3', showFavorites && 'fill-amber-500 text-amber-500')}
          aria-hidden="true"
        />
        {t('settings.favorites')}
      </button>
      {availableTags.map((tag) => {
        const active = activeTags.includes(tag)
        return (
          <button
            key={tag}
            type="button"
            data-testid="catalog-filter-tag"
            aria-pressed={active}
            className={chipClassName(active)}
            onClick={() => onToggleTag(tag)}
          >
            {tag}
          </button>
        )
      })}
    </div>
  )
}

export { CatalogFilterChips }
