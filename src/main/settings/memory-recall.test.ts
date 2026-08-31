// Tests for renderMemoryRecallInstructions: the bounded memory→system-prompt renderer.
// The contract: memory off → nothing; autoRecall off per category → that category excluded;
// undefined autoRecall behaves as on; caps (notes per category, total chars) never exceeded;
// a block that doesn't fit the remaining budget is skipped whole, never split.

import { describe, expect, it } from 'vitest'

import type { MemorySettings } from '../../shared/settings'
import { renderMemoryRecallInstructions } from './memory-recall'

const memoryFixture = (overrides: Partial<MemorySettings> = {}): MemorySettings => ({
  enabled: true,
  categories: [{ id: 'about-you', name: 'About you', createdAt: 1 }],
  notes: [
    {
      id: 'n1',
      categoryId: 'about-you',
      text: 'Prefers concise answers',
      createdAt: 1,
      updatedAt: 1
    }
  ],
  ...overrides
})

describe('renderMemoryRecallInstructions', () => {
  it('returns nothing when memory is undefined or disabled', () => {
    expect(renderMemoryRecallInstructions(undefined)).toBeUndefined()
    expect(renderMemoryRecallInstructions(memoryFixture({ enabled: false }))).toBeUndefined()
  })

  it('returns nothing when memory has no notes', () => {
    expect(renderMemoryRecallInstructions(memoryFixture({ notes: [] }))).toBeUndefined()
  })

  it('recalls notes under the built-in category with autoRecall undefined (on)', () => {
    const result = renderMemoryRecallInstructions(memoryFixture())

    expect(result).toContain('## About you')
    expect(result).toContain('- Prefers concise answers')
    expect(result).toContain('persistent memory')
  })

  it('excludes categories with autoRecall off', () => {
    const memory = memoryFixture({
      categories: [
        { id: 'about-you', name: 'About you', createdAt: 1, autoRecall: false },
        { id: 'lab', name: 'Lab facts', createdAt: 2, autoRecall: true }
      ],
      notes: [
        { id: 'n1', categoryId: 'about-you', text: 'Secret', createdAt: 1, updatedAt: 1 },
        { id: 'n2', categoryId: 'lab', text: 'Shared', createdAt: 2, updatedAt: 2 }
      ]
    })

    const result = renderMemoryRecallInstructions(memory)
    expect(result).toContain('Lab facts')
    expect(result).toContain('- Shared')
    expect(result).not.toContain('Secret')
    expect(result).not.toContain('About you')
  })

  it('caps notes per category (newest first) and total block size', () => {
    const manyNotes = Array.from({ length: 30 }, (_, index) => ({
      id: `n${index}`,
      categoryId: 'about-you',
      text: `note ${index}`,
      createdAt: index,
      updatedAt: index
    }))
    const result = renderMemoryRecallInstructions(memoryFixture({ notes: manyNotes }))

    // Only the newest 20 appear.
    expect(result).toContain('- note 29')
    expect(result).not.toContain('- note 9')

    // A single gigantic note is truncated; multi-note blocks respect the char budget.
    const giantNote = memoryFixture({
      notes: [
        {
          id: 'n1',
          categoryId: 'about-you',
          text: 'x'.repeat(5000),
          createdAt: 1,
          updatedAt: 1
        }
      ]
    })
    const giant = renderMemoryRecallInstructions(giantNote)
    expect(giant).toBeDefined()
    expect(giant!.length).toBeLessThan(4500)
  })

  it('drops whole blocks once the total budget is exhausted (never splits)', () => {
    // 8 categories × 1 max-size note: each block is ~620 chars, the 4000-char budget fits ~6
    // whole blocks. The remainder must be dropped as whole blocks, not truncated mid-note.
    const categories = Array.from({ length: 8 }, (_, index) => ({
      id: `c${index}`,
      name: `Category ${index}`,
      createdAt: index
    }))
    const notes = categories.map((category, index) => ({
      id: `n${index}`,
      categoryId: category.id,
      text: 'z'.repeat(600),
      createdAt: index,
      updatedAt: index
    }))

    const result = renderMemoryRecallInstructions({ enabled: true, categories, notes })

    expect(result).toContain('## Category 0')
    expect(result).toContain('## Category 5')
    expect(result).not.toContain('## Category 6')
    expect(result).not.toContain('## Category 7')
    expect(result!.length).toBeLessThan(4000)
  })

  it('normalizes embedded newlines inside a note to single spaces', () => {
    const memory = memoryFixture({
      notes: [
        {
          id: 'n1',
          categoryId: 'about-you',
          text: 'Line one\n\nLine two\nLine three',
          createdAt: 1,
          updatedAt: 1
        }
      ]
    })

    const result = renderMemoryRecallInstructions(memory)
    expect(result).toContain('- Line one Line two Line three')
    expect(result).not.toContain('\n\n-')
  })

  it('appends save guidance for categories with a prompt', () => {
    const memory = memoryFixture({
      categories: [
        { id: 'about-you', name: 'About you', createdAt: 1 },
        {
          id: 'lab',
          name: 'Lab facts',
          createdAt: 2,
          prompt: 'Save anything that cost >10 minutes to debug'
        }
      ],
      notes: [
        {
          id: 'n1',
          categoryId: 'about-you',
          text: 'Prefers concise answers',
          createdAt: 1,
          updatedAt: 1
        }
      ]
    })

    const result = renderMemoryRecallInstructions(memory)
    expect(result).toContain('memory_save_note')
    expect(result).toContain('Lab facts: Save anything that cost >10 minutes to debug')
    // Categories without a prompt are not listed in the save guidance.
    expect(result).not.toContain('About you: ')
  })

  it('excludes superseded notes from recall (provenance)', () => {
    const memory = memoryFixture({
      notes: [
        {
          id: 'n1',
          categoryId: 'about-you',
          text: 'Prefers concise answers',
          createdAt: 1,
          updatedAt: 1
        },
        {
          id: 'n2',
          categoryId: 'about-you',
          text: 'Prefers terse bullet answers now',
          createdAt: 2,
          updatedAt: 2
        },
        {
          id: 'n3',
          categoryId: 'about-you',
          text: 'Old superseded note',
          createdAt: 3,
          updatedAt: 3,
          supersededBy: 'n4'
        }
      ]
    })

    const result = renderMemoryRecallInstructions(memory)
    // Active notes are recalled.
    expect(result).toContain('- Prefers concise answers')
    expect(result).toContain('- Prefers terse bullet answers now')
    // The superseded note is not recalled.
    expect(result).not.toContain('Old superseded note')
  })
})
