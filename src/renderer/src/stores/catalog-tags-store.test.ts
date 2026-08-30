// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  isValidTag,
  MAX_TAGS_PER_RESOURCE,
  normalizeTag,
  useCatalogTagsStore
} from './catalog-tags-store'

describe('catalog tags store', () => {
  beforeEach(() => {
    window.localStorage.clear()
    useCatalogTagsStore.setState({ entries: {} })
  })

  it('toggles favorites per resource', () => {
    useCatalogTagsStore.getState().toggleFavorite('skill:alpha')
    expect(useCatalogTagsStore.getState().entries['skill:alpha']?.favorite).toBe(true)

    useCatalogTagsStore.getState().toggleFavorite('skill:alpha')
    expect(useCatalogTagsStore.getState().entries['skill:alpha']?.favorite).toBe(false)
  })

  it('adds normalized, deduplicated tags and caps the count', () => {
    const { addTag } = useCatalogTagsStore.getState()
    for (let index = 0; index < MAX_TAGS_PER_RESOURCE + 2; index += 1) {
      addTag('connector:pubmed', `tag-${index}`)
    }
    const tags = useCatalogTagsStore.getState().entries['connector:pubmed']?.tags ?? []
    expect(tags).toHaveLength(MAX_TAGS_PER_RESOURCE)
    expect(tags[0]).toBe('tag-0')

    addTag('connector:pubmed', '  Tag-1  ')
    addTag('connector:pubmed', 'TAG-1')
    expect(tags.filter((tag) => tag === 'tag-1')).toHaveLength(1)
  })

  it('removes tags case-insensitively', () => {
    const { addTag, removeTag } = useCatalogTagsStore.getState()
    addTag('specialist:analysis', 'Wet-Lab')
    removeTag('specialist:analysis', 'wet-lab')
    expect(useCatalogTagsStore.getState().entries['specialist:analysis']?.tags).toEqual([])
  })

  it('replaces the tag set with setTags', () => {
    const { setTags } = useCatalogTagsStore.getState()
    setTags('skill:alpha', ['  Genomic ', 'genomic', 'Molecular', ''])
    expect(useCatalogTagsStore.getState().entries['skill:alpha']?.tags).toEqual([
      'Genomic',
      'Molecular'
    ])
  })

  it('persists entries to localStorage', () => {
    const { addTag, toggleFavorite } = useCatalogTagsStore.getState()
    addTag('skill:alpha', 'docking')
    toggleFavorite('skill:alpha')

    const raw = window.localStorage.getItem('purescience.catalog-tags.v1')
    expect(raw).not.toBeNull()
    expect(JSON.parse(raw ?? '{}')).toEqual({
      'skill:alpha': { tags: ['docking'], favorite: true }
    })
  })

  it('rehydrates from localStorage on module load', async () => {
    window.localStorage.setItem(
      'purescience.catalog-tags.v1',
      JSON.stringify({ 'skill:beta': { tags: ['md'], favorite: true } })
    )
    vi.resetModules()
    const fresh = await import('./catalog-tags-store')
    expect(fresh.useCatalogTagsStore.getState().entries['skill:beta']).toEqual({
      tags: ['md'],
      favorite: true
    })
  })

  it('validates tag shape', () => {
    expect(normalizeTag('  wet   lab  ')).toBe('wet lab')
    expect(isValidTag('x')).toBe(true)
    expect(isValidTag('x'.repeat(24))).toBe(true)
    expect(isValidTag('x'.repeat(25))).toBe(false)
    expect(isValidTag('   ')).toBe(false)
  })
})
