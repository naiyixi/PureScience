import { useMemo } from 'react'

import { useCatalogTagsStore } from '@/stores/catalog-tags-store'
import { useSettingsStore } from '@/stores/settings-store'
import { useSpecialistStore } from '@/stores/specialist-store'

// A catalog resource carrying a tag, identified by its store namespace prefix.
export type CatalogTagResource = {
  kind: 'skill' | 'connector' | 'specialist'
  id: string
}

const RESOURCE_KIND_PATTERN = /^(skill|connector|specialist):(.+)$/u

// Resolves every resource carrying the selected tag across the skills / connectors /
// specialists catalogs. Used by the Tags settings surface (master-detail).
export const useCatalogTagsCounts = (
  tag: string | undefined
): CatalogTagResource[] => {
  const entries = useCatalogTagsStore((state) => state.entries)
  const skills = useSettingsStore((state) => state.skills)
  const connectors = useSettingsStore((state) => state.connectors)
  const specialists = useSpecialistStore((state) => state.items)

  return useMemo(() => {
    if (!tag) return []
    const target = tag.toLowerCase()
    const resources: CatalogTagResource[] = []
    for (const [resourceId, entry] of Object.entries(entries)) {
      if (!entry.tags.some((existing) => existing.toLowerCase() === target)) continue
      const match = RESOURCE_KIND_PATTERN.exec(resourceId)
      if (!match) continue
      const kind = match[1] as CatalogTagResource['kind']
      const id = match[2]
      // Keep only resources that still exist in their catalog (deleted items drop out).
      const exists =
        kind === 'skill'
          ? skills.some((skill) => skill.id === id)
          : kind === 'connector'
            ? connectors.some((connector) => connector.id === id)
            : specialists.some((specialist) => specialist.id === id)
      if (exists) resources.push({ kind, id })
    }
    return resources.sort((left, right) => left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id))
  }, [connectors, entries, skills, specialists, tag])
}

// Resolves a display name for a resource from its catalog (falls back to the raw id).
export const resolveCatalogResourceName = (
  resource: CatalogTagResource
): string => {
  const skills = useSettingsStore.getState().skills
  const connectors = useSettingsStore.getState().connectors
  const specialists = useSpecialistStore.getState().items
  switch (resource.kind) {
    case 'skill':
      return skills.find((skill) => skill.id === resource.id)?.name ?? resource.id
    case 'connector':
      return connectors.find((connector) => connector.id === resource.id)?.displayName ?? resource.id
    case 'specialist': {
      const item = specialists.find((specialist) => specialist.id === resource.id)
      if (!item) return resource.id
      if (item.kind === 'custom') return item.displayName ?? item.name ?? resource.id
      if (item.kind === 'builtin') return item.displayName ?? resource.id
      return resource.id
    }
  }
}
