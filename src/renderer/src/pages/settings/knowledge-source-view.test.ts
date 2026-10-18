import { describe, expect, it } from 'vitest'

import type { KnowledgeSource } from '../../../../shared/knowledge'
import {
  filterAndSortKnowledgeSources,
  isNarrowed,
  type KnowledgeSourceView
} from './knowledge-source-view'

const source = (overrides: Partial<KnowledgeSource> & { id: string }): KnowledgeSource => ({
  kind: 'file',
  location: `/tmp/${overrides.id}.md`,
  label: `${overrides.id}.md`,
  fingerprint: { algorithm: 'sha256', value: 'a'.repeat(64), bytes: 10 },
  registeredAt: 1,
  updatedAt: 1,
  ...overrides
})

const view = (overrides: Partial<KnowledgeSourceView> = {}): KnowledgeSourceView => ({
  text: '',
  kind: 'all',
  sort: 'store',
  ...overrides
})

const labelsOf = (sources: readonly KnowledgeSource[]): string[] => sources.map((s) => s.label)

describe('filterAndSortKnowledgeSources', () => {
  it('keeps the register order when no sort is chosen', () => {
    const sources = [source({ id: 'zulu' }), source({ id: 'alpha' }), source({ id: 'mike' })]
    expect(labelsOf(filterAndSortKnowledgeSources(sources, view()))).toEqual([
      'zulu.md',
      'alpha.md',
      'mike.md'
    ])
  })

  it('matches the label, the location and the landed URL, case-insensitively', () => {
    const sources = [
      source({ id: 'cohort', label: 'Cohort-Notes.md' }),
      source({ id: 'paper', kind: 'url', location: 'https://example.org/EGFR', label: '例：EGFR' }),
      source({
        id: 'redirected',
        kind: 'url',
        location: 'https://old.example.org/x',
        finalUrl: 'https://new.example.org/cohort',
        label: 'landed'
      })
    ]
    expect(labelsOf(filterAndSortKnowledgeSources(sources, view({ text: 'cohort' })))).toEqual([
      'Cohort-Notes.md',
      'landed'
    ])
    expect(labelsOf(filterAndSortKnowledgeSources(sources, view({ text: ' egfr ' })))).toEqual([
      '例：EGFR'
    ])
  })

  it('narrows by kind without touching the rows of the other kind', () => {
    const sources = [
      source({ id: 'a' }),
      source({ id: 'b', kind: 'url', location: 'https://x.test' })
    ]
    expect(labelsOf(filterAndSortKnowledgeSources(sources, view({ kind: 'url' })))).toEqual([
      'b.md'
    ])
    expect(filterAndSortKnowledgeSources(sources, view({ kind: 'url' })).length).toBe(1)
  })

  it('returns nothing — not everything — when the filter matches nothing', () => {
    const sources = [source({ id: 'a' }), source({ id: 'b' })]
    expect(filterAndSortKnowledgeSources(sources, view({ text: 'no-such-source' }))).toEqual([])
  })

  it('sorts by label case-insensitively and compares numeric runs as numbers', () => {
    const sources = [
      source({ id: 'x', label: 'note-10.md' }),
      source({ id: 'y', label: 'Note-2.md' }),
      source({ id: 'z', label: 'alpha.md' })
    ]
    expect(labelsOf(filterAndSortKnowledgeSources(sources, view({ sort: 'label' })))).toEqual([
      'alpha.md',
      'Note-2.md',
      'note-10.md'
    ])
  })

  it('sorts by size largest-first and keeps equal sizes in register order', () => {
    const sources = [
      source({
        id: 'small',
        fingerprint: { algorithm: 'sha256', value: 'a'.repeat(64), bytes: 5 }
      }),
      source({
        id: 'big',
        fingerprint: { algorithm: 'sha256', value: 'b'.repeat(64), bytes: 900 }
      }),
      source({
        id: 'tie-first',
        fingerprint: { algorithm: 'sha256', value: 'c'.repeat(64), bytes: 40 }
      }),
      source({
        id: 'tie-second',
        fingerprint: { algorithm: 'sha256', value: 'd'.repeat(64), bytes: 40 }
      })
    ]
    expect(labelsOf(filterAndSortKnowledgeSources(sources, view({ sort: 'bytes' })))).toEqual([
      'big.md',
      'tie-first.md',
      'tie-second.md',
      'small.md'
    ])
  })

  it('filters before sorting, so a sort never resurrects a filtered-out row', () => {
    const sources = [
      source({
        id: 'keep-small',
        kind: 'file',
        fingerprint: { algorithm: 'sha256', value: 'a'.repeat(64), bytes: 1 }
      }),
      source({
        id: 'skip-big',
        kind: 'url',
        location: 'https://x.test',
        fingerprint: { algorithm: 'sha256', value: 'b'.repeat(64), bytes: 999 }
      })
    ]
    expect(
      labelsOf(filterAndSortKnowledgeSources(sources, view({ kind: 'file', sort: 'bytes' })))
    ).toEqual(['keep-small.md'])
  })
})

describe('isNarrowed', () => {
  it('is false only when neither the text nor the kind narrows anything', () => {
    expect(isNarrowed(view())).toBe(false)
    expect(isNarrowed(view({ text: '   ' }))).toBe(false)
    expect(isNarrowed(view({ text: 'tp53' }))).toBe(true)
    expect(isNarrowed(view({ kind: 'url' }))).toBe(true)
  })
})
