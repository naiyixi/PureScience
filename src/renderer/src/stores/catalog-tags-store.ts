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
  // Deletes a tag from every resource that carries it (cross-resource management).
  deleteTag: (tag: string) => void
  // Renames a tag across every resource, merging into an existing tag when present.
  renameTag: (from: string, to: string) => void
}

// Aggregate view of one tag across all catalog resources (for the Tags settings surface).
export type CatalogTagSummary = {
  name: string
  resourceCount: number
}

export const selectTagSummaries = (entries: Record<string, CatalogTagsEntry>): CatalogTagSummary[] => {
  const counts = new Map<string, number>()
  for (const entry of Object.values(entries)) {
    for (const tag of entry.tags) {
      counts.set(tag.toLowerCase(), (counts.get(tag.toLowerCase()) ?? 0) + 1)
    }
  }
  return Array.from(counts.entries())
    .map(([key, resourceCount]) => ({ name: key, resourceCount }))
    .sort((left, right) => right.resourceCount - left.resourceCount || left.name.localeCompare(right.name))
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
        ? entry.tags
            .filter((tag): tag is string => typeof tag === 'string')
            .slice(0, MAX_TAGS_PER_RESOURCE)
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
  },

  deleteTag: (tag) => {
    const target = normalizeTag(tag).toLowerCase()
    if (!target) return
    const entries: Record<string, CatalogTagsEntry> = {}
    for (const [resourceId, entry] of Object.entries(get().entries)) {
      const tags = entry.tags.filter((existing) => existing.toLowerCase() !== target)
      if (tags.length !== entry.tags.length || entry.favorite) {
        entries[resourceId] = tags.length === entry.tags.length ? entry : { ...entry, tags }
      }
    }
    set({ entries })
  },

  renameTag: (from, to) => {
    const source = normalizeTag(from).toLowerCase()
    const destination = normalizeTag(to)
    if (!source || !isValidTag(destination) || source === destination.toLowerCase()) return
    const entries: Record<string, CatalogTagsEntry> = {}
    for (const [resourceId, entry] of Object.entries(get().entries)) {
      const hadSource = entry.tags.some((tag) => tag.toLowerCase() === source)
      if (!hadSource) {
        entries[resourceId] = entry
        continue
      }
      const seen = new Set<string>()
      const tags: string[] = []
      for (const tag of entry.tags) {
        // Dedupe against the post-rename identity so renaming 'docking' to 'MD' merges with an
        // existing 'md' instead of leaving both spellings.
        const key = tag.toLowerCase() === source ? destination.toLowerCase() : tag.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        tags.push(tag.toLowerCase() === source ? destination : tag)
        if (tags.length >= MAX_TAGS_PER_RESOURCE) break
      }
      entries[resourceId] = { ...entry, tags }
    }
    set({ entries })
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
