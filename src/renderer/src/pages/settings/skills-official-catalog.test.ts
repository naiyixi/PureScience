import { describe, expect, it } from 'vitest'

import type { MarketplaceSnapshot } from '../../../../shared/specialist-marketplace'
import { officialCatalogSentence } from './skills-official-catalog'

// The dictionaries carry the placeholders in the VALUE, so this fake has to as well: a translator that only
// echoes keys would never exercise the substitution the sentence depends on.
const VALUES: Record<string, string> = {
  'settings.skillsOfficialCatalogUnread': 'Not checked yet.',
  'settings.skillsOfficialCatalogAbsent': 'Source read, but it carries no skills catalog.',
  'settings.skillsOfficialCatalogPublished': 'Published: {n} skills.',
  'settings.skillsOfficialCatalogUnreachable': 'Could not read the official catalog here: {reason}',
  'settings.skillsOfficialCatalogNoReason': 'no reason reported'
}

const t = ((key: string, vars?: Record<string, string>) => {
  let value = VALUES[key] ?? key
  for (const [name, replacement] of Object.entries(vars ?? {})) {
    value = value.replace(`{${name}}`, replacement)
  }

  return value
}) as Parameters<typeof officialCatalogSentence>[1]

const snapshot = (
  skillsCatalog: MarketplaceSnapshot['skillsCatalog'],
  failures: MarketplaceSnapshot['failures'] = []
): MarketplaceSnapshot =>
  ({ sources: [], specialists: [], failures, skillsCatalog }) as MarketplaceSnapshot

describe('official catalog sentence', () => {
  it('says it has not been checked yet rather than implying it is empty', () => {
    expect(officialCatalogSentence(undefined, t)).toBe('Not checked yet.')
  })

  it('separates "read, no skills section" from "could not be read"', () => {
    expect(officialCatalogSentence(snapshot({ state: 'absent' }), t)).toContain('no skills catalog')

    const unreachable = officialCatalogSentence(
      snapshot({ state: 'unreachable' }, [
        {
          sourceId: 'purescience-official',
          sourceName: 'Official',
          code: 'unavailable',
          message: 'HTTP 404'
        }
      ]),
      t
    )
    expect(unreachable).toContain('HTTP 404')
  })

  it('reports a published catalog with its count', () => {
    expect(officialCatalogSentence(snapshot({ state: 'published', count: 12 }), t)).toContain('12')
  })

  it('names the absence of a reason when the source failure carries none', () => {
    expect(officialCatalogSentence(snapshot({ state: 'unreachable' }), t)).toContain(
      'no reason reported'
    )
  })
})
