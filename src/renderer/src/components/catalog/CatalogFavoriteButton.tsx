import { Star } from 'lucide-react'

import { cn } from '@/lib/utils'
import { useCatalogTagsStore } from '@/stores/catalog-tags-store'

type CatalogFavoriteButtonProps = {
  resourceId: string
  // Localized aria-label, e.g. `t('settings.favoriteSkill').replace('{name}', skill.name)`.
  label: string
  className?: string
}

// Favorite (star) toggle shared by the skills / connectors / specialists catalogs.
const CatalogFavoriteButton = ({
  resourceId,
  label,
  className
}: CatalogFavoriteButtonProps): React.JSX.Element => {
  const favorite = useCatalogTagsStore((state) => state.entries[resourceId]?.favorite ?? false)
  const toggleFavorite = useCatalogTagsStore((state) => state.toggleFavorite)

  return (
    <button
      type="button"
      data-testid="catalog-favorite"
      aria-pressed={favorite}
      aria-label={label}
      title={label}
      onClick={() => toggleFavorite(resourceId)}
      className={cn(
        'shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-bg-100 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
        favorite && 'text-amber-500 hover:text-amber-500',
        className
      )}
    >
      <Star
        className={cn('size-4', favorite && 'fill-amber-500 text-amber-500')}
        aria-hidden="true"
      />
    </button>
  )
}

export { CatalogFavoriteButton }
