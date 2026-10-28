import { describe, expect, it } from 'vitest'

import {
  countCitedNotRead,
  isCitedNotRead,
  matchesReadingFilter,
  referenceReadingStatusOf
} from './references-reading'

// B3. The whole feature rests on two readings that must never blur:
//
//   1. a record with no stored value is UNREAD, so a library imported before this layer behaves as before;
//   2. "cited but not read" counts `unread` AND `reading` — someone halfway through has not read it, and a
//      callout that said otherwise would let a manuscript cite a paper nobody finished.
describe('reference reading state', () => {
  it('reads an absent value as unread, and an unknown one too', () => {
    expect(referenceReadingStatusOf(undefined)).toBe('unread')
    expect(referenceReadingStatusOf(null)).toBe('unread')
    expect(referenceReadingStatusOf('')).toBe('unread')
    // A value written by a future version is not silently treated as `read`.
    expect(referenceReadingStatusOf('skimmed')).toBe('unread')
    expect(referenceReadingStatusOf('read')).toBe('read')
    expect(referenceReadingStatusOf('reading')).toBe('reading')
  })

  it('counts cited-but-not-read for unread and reading, and not for read', () => {
    expect(isCitedNotRead({ citedAt: 1, readingStatus: undefined })).toBe(true)
    expect(isCitedNotRead({ citedAt: 1, readingStatus: 'reading' })).toBe(true)
    expect(isCitedNotRead({ citedAt: 1, readingStatus: 'read' })).toBe(false)
    // Never cited: not this callout's business, however unread it is.
    expect(isCitedNotRead({ readingStatus: 'unread' })).toBe(false)
    expect(
      countCitedNotRead([
        { citedAt: 1, readingStatus: 'unread' },
        { citedAt: 2, readingStatus: 'reading' },
        { citedAt: 3, readingStatus: 'read' },
        { readingStatus: 'unread' }
      ])
    ).toBe(2)
  })

  it('filters on the same reading the callout counts', () => {
    expect(matchesReadingFilter({ readingStatus: undefined }, 'any')).toBe(true)
    expect(matchesReadingFilter({ readingStatus: undefined }, 'unread')).toBe(true)
    expect(matchesReadingFilter({ readingStatus: 'read' }, 'unread')).toBe(false)
    expect(matchesReadingFilter({ readingStatus: 'reading' }, 'reading')).toBe(true)
  })
})
