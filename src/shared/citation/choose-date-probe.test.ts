import { describe, expect, it } from 'vitest'

import { citationStyleFromImport, importCslStyle, type CslDocumentHasher } from './csl'
import { citationItemFromReference, formatCitation } from './format'
import type { CitationItemType } from './types'

const hasher: CslDocumentHasher = (xml) => `len:${xml.length}`

// A style whose whole bibliography body is the fragment under test, so a failing fragment points at
// one construct rather than at a whole document.
const styleDocument = (bibliography: string): string =>
  `<style xmlns="http://purl.org/net/xbiblio/csl" version="1.0">
  <info>
    <title>Probe</title>
    <id>http://example.org/probe</id>
    <rights license="CC0"/>
  </info>
  <macro name="year">
    <date variable="issued"><date-part name="year"/></date>
  </macro>
  <bibliography>
    <layout suffix=".">
      <text variable="title" suffix=". "/>
      ${bibliography}
    </layout>
  </bibliography>
</style>`

const render = (bibliography: string, itemType: CitationItemType): string => {
  const outcome = importCslStyle(styleDocument(bibliography), 'probe.csl', { hash: hasher })
  if (outcome.status !== 'imported') throw new Error(`import rejected: ${outcome.reason}`)
  const definition = citationStyleFromImport(outcome.style)
  return formatCitation(
    citationItemFromReference({
      title: 'A probe record',
      authors: [{ name: 'Ada Probe' }],
      venue: 'Journal of Probes',
      year: 2026,
      volume: '3',
      itemType
    }),
    definition.id,
    {},
    [definition]
  ).text
}

describe('date rendering through the constructs real styles use', () => {
  it('a plain macro call', () => {
    expect(render('<text macro="year"/>', 'journal-article')).toContain('2026')
  })

  it('a macro call inside a group', () => {
    expect(
      render(
        '<group delimiter=", "><text macro="year"/><text variable="volume"/></group>',
        'journal-article'
      )
    ).toContain('2026')
  })

  it('a macro call inside a choose-by-type branch that matches', () => {
    expect(
      render(
        '<choose><if type="article-journal"><text macro="year"/></if><else><text value="NO-YEAR"/></else></choose>',
        'journal-article'
      )
    ).toContain('2026')
  })

  it('a macro call inside a nested choose', () => {
    expect(
      render(
        '<choose><if variable="volume"><group delimiter=" "><text value="v"/><choose><if type="article-journal"><text macro="year"/></if></choose></group></if></choose>',
        'journal-article'
      )
    ).toContain('2026')
  })

  it('a date inside a macro that other macros reference', () => {
    expect(
      render(
        '<group delimiter=" "><text macro="year"/><group delimiter=" "><text macro="year"/></group></group>',
        'journal-article'
      )
    ).toContain('2026')
  })
})
