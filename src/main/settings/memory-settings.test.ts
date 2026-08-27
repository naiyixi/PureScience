// Tests for sanitizeMemorySettings: the untrusted-JSON gate between settings.json and the memory
// panel. Malformed entries must be dropped, dangling notes must never survive, and the master
// switch must default to off so a corrupt write cannot silently resume memory.

import { describe, expect, it } from 'vitest'

import { sanitizeMemorySettings } from './repository'

describe('sanitizeMemorySettings', () => {
  it('returns undefined for a non-record payload', () => {
    expect(sanitizeMemorySettings(undefined)).toBeUndefined()
    expect(sanitizeMemorySettings('about you')).toBeUndefined()
    expect(sanitizeMemorySettings(null)).toBeUndefined()
  })

  it('keeps well-formed categories and notes', () => {
    const result = sanitizeMemorySettings({
      enabled: true,
      categories: [{ id: 'about-you', name: 'About you', createdAt: 1000 }],
      notes: [
        { id: 'note-1', categoryId: 'about-you', text: 'Prefers concise answers', createdAt: 1001, updatedAt: 1002 }
      ]
    })

    expect(result).toEqual({
      enabled: true,
      categories: [{ id: 'about-you', name: 'About you', createdAt: 1000 }],
      notes: [
        { id: 'note-1', categoryId: 'about-you', text: 'Prefers concise answers', createdAt: 1001, updatedAt: 1002 }
      ]
    })
  })

  it('drops notes whose category vanished and entries missing required fields', () => {
    const result = sanitizeMemorySettings({
      enabled: true,
      categories: [{ id: 'about-you', name: 'About you', createdAt: 1000 }],
      notes: [
        // Valid: survives.
        { id: 'note-1', categoryId: 'about-you', text: 'Keep', createdAt: 1, updatedAt: 1 },
        // Dangling category: dropped.
        { id: 'note-2', categoryId: 'gone', text: 'Dangling', createdAt: 1, updatedAt: 1 },
        // Missing id: dropped.
        { categoryId: 'about-you', text: 'No id', createdAt: 1, updatedAt: 1 },
        // Empty text: dropped.
        { id: 'note-4', categoryId: 'about-you', text: '', createdAt: 1, updatedAt: 1 },
        // Non-string text: dropped.
        { id: 'note-5', categoryId: 'about-you', text: 42, createdAt: 1, updatedAt: 1 }
      ]
    })

    expect(result?.notes).toEqual([
      { id: 'note-1', categoryId: 'about-you', text: 'Keep', createdAt: 1, updatedAt: 1 }
    ])
  })

  it('defaults the master switch to off for a malformed or absent flag', () => {
    expect(sanitizeMemorySettings({ categories: [], notes: [] })?.enabled).toBe(false)
    expect(sanitizeMemorySettings({ enabled: 'yes', categories: [], notes: [] })?.enabled).toBe(false)
    expect(sanitizeMemorySettings({ enabled: true, categories: [], notes: [] })?.enabled).toBe(true)
  })

  it('returns an empty-but-present memory for a payload with no arrays', () => {
    expect(sanitizeMemorySettings({ enabled: true })).toEqual({
      enabled: true,
      categories: [],
      notes: []
    })
  })
})
