import { describe, expect, it } from 'vitest'

import { buildGlobalSearchHitCitation } from './global-search-citation'

describe('buildGlobalSearchHitCitation', () => {
  it('builds a GB/T 7714 citation from the literature record the search returned', () => {
    const citation = buildGlobalSearchHitCitation(
      {
        scope: 'literature',
        title: 'Reproducible sine tables',
        citation: {
          authors: ['Zhang San', 'Li Si'],
          year: 2024,
          venue: 'Nature Methods',
          doi: '10.1000/xyz'
        }
      },
      { retrievedAt: '2026-09-14' }
    )

    expect(citation).toBeDefined()
    // GB/T 7714 romanizes: family name first, given names abbreviated, elements in fixed order.
    expect(citation).toBe(
      'San Z., Si L. Reproducible sine tables[J]. Nature Methods, 2024. 10.1000/xyz'
    )
  })

  it('renders an author list the GB/T way, not as raw names', () => {
    const citation = buildGlobalSearchHitCitation({
      scope: 'literature',
      title: 'On重复性',
      citation: { authors: ['Zhang San', 'Li Si', 'Wang Wu'], year: 2023 }
    })

    expect(citation).toContain('San Z., Si L., Wu W.')
  })

  it('returns nothing for a hit that is not literature', () => {
    expect(
      buildGlobalSearchHitCitation({
        scope: 'messages',
        title: 'Sine plot',
        citation: { authors: ['Zhang San'] }
      })
    ).toBeUndefined()
  })

  it('returns nothing when the literature hit carries no citation data', () => {
    // No stub, no invented author: the action is simply absent.
    expect(buildGlobalSearchHitCitation({ scope: 'literature', title: 'Untitled' })).toBeUndefined()
  })
})
