import { describe, expect, it } from 'vitest'

import {
  GLOBAL_SEARCH_PIN_MAX_SETS,
  GLOBAL_SEARCH_PIN_SCHEMA_VERSION,
  type GlobalSearchPin
} from '../../../../shared/global-search-pins'

import {
  appliedPinFor,
  contentFiltersForPin,
  pinFiltersForContentFilters,
  searchPinFailureLabelKey
} from './use-search-pins'

const pin = (overrides: Partial<GlobalSearchPin> = {}): GlobalSearchPin => ({
  schemaVersion: GLOBAL_SEARCH_PIN_SCHEMA_VERSION,
  id: 'pin-1',
  name: 'Human mtDNA only',
  savedAt: '2026-09-21T10:00:00.000Z',
  filters: { role: 'agent', extensions: ['csv'] },
  ...overrides
})

describe('pinFiltersForContentFilters', () => {
  it('carries each filter the palette can set, in the shape the request takes', () => {
    expect(
      pinFiltersForContentFilters({ role: 'agent', extension: '.csv', referenceType: 'doi' })
    ).toEqual({ role: 'agent', extensions: ['.csv'], referenceTypes: ['doi'] })
  })

  it('refuses to make a pin out of nothing', () => {
    // A set with no filters names "everything", which is what the absence of a pin already means.
    expect(pinFiltersForContentFilters({})).toBeUndefined()
  })
})

describe('contentFiltersForPin', () => {
  it('puts the palette-supported filters back', () => {
    expect(
      contentFiltersForPin(pin({ filters: { role: 'user', referenceTypes: ['arxiv'] } }))
    ).toEqual({ role: 'user', referenceType: 'arxiv' })
  })

  it('ignores what the palette cannot express rather than guessing', () => {
    expect(contentFiltersForPin(pin({ filters: { projectId: 'project-a' } }))).toEqual({})
  })
})

describe('appliedPinFor', () => {
  it('names the set whose filters are exactly the ones in force', () => {
    expect(appliedPinFor([pin()], { role: 'agent', extension: 'csv' })?.id).toBe('pin-1')
  })

  it('stops naming the set as soon as a filter changes', () => {
    expect(appliedPinFor([pin()], { role: 'agent' })).toBeUndefined()
    expect(appliedPinFor([pin()], { role: 'user', extension: 'csv' })).toBeUndefined()
    expect(appliedPinFor([pin()], {})).toBeUndefined()
  })

  it('never calls a set applied when it holds a filter the palette cannot put back', () => {
    // The set describes a narrower question (a project, a date bound) than the palette can reproduce, so its
    // name must not end up on results it did not produce.
    expect(
      appliedPinFor(
        [pin({ filters: { role: 'agent', extensions: ['csv'], projectId: 'project-a' } })],
        {
          role: 'agent',
          extension: 'csv'
        }
      )
    ).toBeUndefined()
  })
})

describe('searchPinFailureLabelKey', () => {
  it('names every way a save can be refused', () => {
    expect(searchPinFailureLabelKey('name-taken')).toBe('gs.pinNameTaken')
    expect(searchPinFailureLabelKey('limit')).toBe('gs.pinLimitReached')
    expect(searchPinFailureLabelKey('needs-filters')).toBe('gs.pinNeedsFilters')
    expect(searchPinFailureLabelKey('failed')).toBe('gs.pinSaveFailed')
  })

  it('the store limit the UI counts against is the one the repository enforces', () => {
    expect(GLOBAL_SEARCH_PIN_MAX_SETS).toBe(50)
  })
})
