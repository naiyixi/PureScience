import { describe, expect, it } from 'vitest'

import { sortMarketplaceListings, type MarketplaceSortKind } from './specialist-marketplace-sort'

const listing = (
  displayName: string,
  version: string
): { displayName: string; version: string } => ({ displayName, version })

describe('sortMarketplaceListings', () => {
  it('sorts newest-first by semver segments', () => {
    const items = [
      listing('Alpha', '1.10.0'),
      listing('Beta', '1.9.1'),
      listing('Gamma', '2.0.0-rc.1'),
      listing('Delta', '1.9.1')
    ]
    const sorted = sortMarketplaceListings(items, 'version')
    expect(sorted.map((item) => item.displayName)).toEqual(['Gamma', 'Alpha', 'Beta', 'Delta'])
  })

  it('sorts case-insensitively by name and keeps equal names stable', () => {
    const items = [
      listing('zebra-specialist', '0.1.0'),
      listing('Alpha', '2.0.0'),
      listing('alpha', '1.0.0'),
      listing('middle', '3.0.0')
    ]
    const sorted = sortMarketplaceListings(items, 'name')
    expect(sorted.map((item) => item.displayName)).toEqual([
      'Alpha',
      'alpha',
      'middle',
      'zebra-specialist'
    ])
  })

  it('falls back to snapshot order when versions are identical', () => {
    const items = [listing('First', '1.0.0'), listing('Second', '1.0.0'), listing('Third', '1.0.0')]
    expect(sortMarketplaceListings(items, 'version').map((item) => item.displayName)).toEqual([
      'First',
      'Second',
      'Third'
    ])
  })

  it('accepts every supported kind without throwing on empty input', () => {
    for (const kind of ['version', 'name'] as MarketplaceSortKind[]) {
      expect(sortMarketplaceListings([], kind)).toEqual([])
    }
  })
})
