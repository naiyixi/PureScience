import { create } from 'zustand'

// Cross-resource catalog tags: skills, connectors and specialists all share the same
// favorite + tag model. Resource ids are namespaced by kind (`skill:<id>`,
// `connector:<id>`, `specialist:<id>`) so the same store backs every catalog panel.
// This is renderer-local UI state — favorites and tags never enter SKILL.md files or
// any main-process config.

const STORAGE_KEY = 'purescience.catalog-tags.v1'

export type CatalogTagsEntry = {
  tags: string[]
  favorite: boolean
}

export type CatalogTagsStoreData = {
  entries: Record<string, CatalogTagsEntry>
}

export type CatalogTagsStoreActions = {
  toggleFavorite: (resourceId: string) => void
  addTag: (resourceId: string, tag: string) => void
  removeTag: (resourceId: string, tag: string) => void
  setTags: (resourceId: string, tags: readonly string[]) => void
}

export type CatalogTagsStore = CatalogTagsStoreData & CatalogTagsStoreActions

export const MAX_TAGS_PER_RESOURCE = 8
export const MAX_TAG_LENGTH = 24

export const normalizeTag = (tag: string): string => tag.trim().replace(/\s+/g, ' ')

export const isValidTag = (tag: string): boolean => {
  const normalized = normalizeTag(tag)
  return normalized.length >= 1 && normalized.length <= MAX_TAG_LENGTH
}

const loadEntries = (): Record<string, CatalogTagsEntry> => {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, CatalogTagsEntry>
    if (typeof parsed !== 'object' || parsed === null) return {}
    const cleaned: Record<string, CatalogTagsEntry> = {}
    for (const [resourceId, entry] of Object.entries(parsed)) {
      if (typeof resourceId !== 'string' || resourceId.length === 0) continue
      if (typeof entry !== 'object' || entry === null) continue
      const tags = Array.isArray(entry.tags)
        ? entry.tags.filter((tag): tag is string => typeof tag === 'string').slice(0, MAX_TAGS_PER_RESOURCE)
        : []
      cleaned[resourceId] = { tags, favorite: Boolean(entry.favorite) }
    }
    return cleaned
  } catch {
    return {}
  }
}

const updateEntry = (
  entries: Record<string, CatalogTagsEntry>,
  resourceId: string,
  patch: Partial<CatalogTagsEntry>
): Record<string, CatalogTagsEntry> => {
  const previous = entries[resourceId] ?? { tags: [], favorite: false }
  return { ...entries, [resourceId]: { ...previous, ...patch } }
}

export const useCatalogTagsStore = create<CatalogTagsStore>((set, get) => ({
  entries: loadEntries(),

  toggleFavorite: (resourceId) =>
    set({
      entries: updateEntry(get().entries, resourceId, {
        favorite: !(get().entries[resourceId]?.favorite ?? false)
      })
    }),

  addTag: (resourceId, tag) => {
    const normalized = normalizeTag(tag)
    if (!isValidTag(normalized)) return
    const current = get().entries[resourceId]?.tags ?? []
    if (current.some((existing) => existing.toLowerCase() === normalized.toLowerCase())) return
    if (current.length >= MAX_TAGS_PER_RESOURCE) return
    set({ entries: updateEntry(get().entries, resourceId, { tags: [...current, normalized] }) })
  },

  removeTag: (resourceId, tag) =>
    set({
      entries: updateEntry(get().entries, resourceId, {
        tags: (get().entries[resourceId]?.tags ?? []).filter(
          (existing) => existing.toLowerCase() !== tag.toLowerCase()
        )
      })
    }),

  setTags: (resourceId, tags) => {
    const seen = new Set<string>()
    const deduped: string[] = []
    for (const raw of tags) {
      const normalized = normalizeTag(raw)
      if (!isValidTag(normalized)) continue
      const key = normalized.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      deduped.push(normalized)
      if (deduped.length >= MAX_TAGS_PER_RESOURCE) break
    }
    set({ entries: updateEntry(get().entries, resourceId, { tags: deduped }) })
  }
}))

// Persist every mutation to localStorage. The payload is tiny (a handful of tags per
// resource), so an unconditional write per action is cheaper than diffing.
if (typeof window !== 'undefined') {
  useCatalogTagsStore.subscribe((state) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state.entries))
    } catch {
      // Storage can be unavailable (private mode / quota); tags just stay in memory.
    }
  })
}
