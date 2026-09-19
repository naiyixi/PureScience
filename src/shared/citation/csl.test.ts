import { describe, expect, it } from 'vitest'

import {
  citationStyleFromImport,
  cslStyleIsNumeric,
  importCslStyle,
  parseXmlDocument,
  type CslDocumentHasher
} from './csl'
import { formatCitation } from './format'
import { citationItemFromReference } from './format'
import type { CitationItem, CitationItemType } from './types'

const hasher: CslDocumentHasher = (xml) => `sha256:${xml.length}`

const styleDocument = (options: {
  id?: string
  title?: string
  rights?: string
  bibliography?: string
  citation?: string
  extra?: string
  defaultLocale?: string
}): string => `<?xml version="1.0" encoding="utf-8"?>
<style xmlns="http://purl.org/net/xbiblio/csl" version="1.0"${
  options.defaultLocale ? ` default-locale="${options.defaultLocale}"` : ''
}>
  <info>
    ${options.title === undefined ? '<title>Test Journal Style</title>' : options.title}
    <id>${options.id ?? 'http://example.org/styles/test-journal'}</id>
    <updated>2026-01-02T00:00:00+00:00</updated>
    ${options.rights === undefined ? '<rights license="http://creativecommons.org/licenses/by-sa/3.0/">CC BY-SA 3.0</rights>' : options.rights}
    <link href="https://example.org/styles/test-journal" rel="self"/>
  </info>
  ${options.extra ?? ''}
  <macro name="author">
    <names variable="author">
      <name name-as-sort-order="all" and="text" initialize-with=". " delimiter=", "/>
      <et-al term="et al."/>
    </names>
  </macro>
  ${options.citation ?? '<citation><layout><text variable="citation-number" prefix="[" suffix="]"/></layout></citation>'}
  ${
    options.bibliography === undefined
      ? `<bibliography>
    <layout suffix=".">
      <text macro="author" suffix=". "/>
      <text variable="title" suffix=". "/>
      <text variable="container-title" font-style="italic" suffix=" "/>
      <group delimiter=", ">
        <text variable="volume"/>
        <text variable="page"/>
      </group>
      <date variable="issued" prefix=" (" suffix=")"><date-part name="year"/></date>
    </layout>
  </bibliography>`
      : options.bibliography
  }
</style>`

const item = (overrides: { itemType?: CitationItemType } = {}): CitationItem =>
  citationItemFromReference({
    title: 'Deep learning for protein design',
    authors: [
      { name: 'Wei Zhang' },
      { name: 'Li Chen' },
      { name: 'John A. Smith' },
      { name: 'Mei Huang' }
    ],
    venue: 'Nature Methods',
    year: 2024,
    volume: '21',
    pages: '145-158',
    doi: '10.1038/s41592-024-01234-5',
    itemType: overrides.itemType
  })

describe('XML reader', () => {
  it('reads nested elements, attributes, self-closing tags and entities', () => {
    const root = parseXmlDocument('<a x="1"><b/><c>d &amp; e</c></a>')
    const style = root.children[0]
    expect(style.kind).toBe('element')
  })

  it('reports unbalanced markup instead of importing a truncated document', () => {
    expect(() => parseXmlDocument('<a><b></a>')).toThrow()
  })
})

describe('importing a CSL style', () => {
  it('keeps the document identity, licence and provenance hash', () => {
    const xml = styleDocument({})
    const outcome = importCslStyle(xml, 'test-journal.csl', { hash: hasher, importedAt: 1 })
    expect(outcome.status).toBe('imported')
    if (outcome.status !== 'imported') return
    expect(outcome.style.id).toBe('csl-import:test-journal')
    expect(outcome.style.license).toContain('creativecommons.org/licenses/by-sa/3.0')
    expect(outcome.style.contentHash).toBe(`sha256:${xml.length}`)
    expect(outcome.style.sourceUrl).toBe('https://example.org/styles/test-journal')
    expect(outcome.style.importedAt).toBe(1)
    expect(outcome.style.defaultLocale).toBe('en-US')
  })

  it('names every construct it cannot render, including flattened formatting attributes', () => {
    const xml = styleDocument({
      extra:
        '<locale><terms><term name="and">and</term></terms></locale><macro name="sorted"><sort><key variable="issued"/></sort></macro>',
      bibliography: `<bibliography>
    <sort><key variable="author"/></sort>
    <layout>
      <names variable="author">
        <name font-style="italic"/>
        <substitute><text variable="title"/></substitute>
      </names>
    </layout>
  </bibliography>`
    })
    const outcome = importCslStyle(xml, 'rich.csl', { hash: hasher })
    expect(outcome.status).toBe('imported')
    if (outcome.status !== 'imported') return
    expect(outcome.style.unsupported).toContain('sort')
    expect(outcome.style.unsupported).toContain('names:substitute')
    expect(outcome.style.unsupported).toContain('attribute:font-style')
    // <locale>/<terms>/<term> are outside the renderer's subset and are named too.
    expect(outcome.style.unsupported.some((name) => name === 'locale' || name === 'terms')).toBe(
      true
    )
  })

  it('refuses a style it cannot attribute, with a named reason', () => {
    const outcome = importCslStyle(styleDocument({ rights: '' }), 'no-license.csl', {
      hash: hasher
    })
    expect(outcome).toEqual({ status: 'rejected', reason: 'missing-license' })
  })

  it('rejects documents that are not a renderable CSL style', () => {
    expect(importCslStyle('<not-a-style/>', 'x.csl', { hash: hasher })).toEqual({
      status: 'rejected',
      reason: 'not-a-style'
    })
    expect(
      importCslStyle(
        '<style><info><title>T</title><rights license="CC0"/></info></style>',
        'x.csl',
        { hash: hasher }
      )
    ).toEqual({ status: 'rejected', reason: 'missing-bibliography' })
    // Attribution is checked before renderability: an unattributable style is never installed.
    expect(
      importCslStyle('<style><info><title>T</title></info></style>', 'x.csl', { hash: hasher })
    ).toEqual({ status: 'rejected', reason: 'missing-license' })
    expect(importCslStyle(styleDocument({ title: '' }), 'x.csl', { hash: hasher })).toEqual({
      status: 'rejected',
      reason: 'missing-title'
    })
    expect(importCslStyle('<style>', 'x.csl', { hash: hasher }).status).toBe('rejected')
  })

  it('rejects an import that would shadow a built-in style id', () => {
    const outcome = importCslStyle(styleDocument({}), 'x.csl', {
      hash: hasher,
      builtinStyleIds: ['csl-import:test-journal']
    })
    expect(outcome).toEqual({
      status: 'rejected',
      reason: 'builtin-id-collision',
      detail: 'csl-import:test-journal'
    })
  })

  it('detects a numbering convention from the in-text layout', () => {
    const numeric = importCslStyle(styleDocument({}), 'n.csl', { hash: hasher })
    const authorDate = importCslStyle(
      styleDocument({
        citation:
          '<citation><layout><text variable="title" prefix="(" suffix=")"/></layout></citation>'
      }),
      'a.csl',
      { hash: hasher }
    )
    if (numeric.status !== 'imported' || authorDate.status !== 'imported') throw new Error('import')
    expect(cslStyleIsNumeric(numeric.style.program)).toBe(true)
    expect(cslStyleIsNumeric(authorDate.style.program)).toBe(false)
    expect(citationStyleFromImport(numeric.style).family).toBe('numeric')
    expect(citationStyleFromImport(authorDate.style).family).toBe('author-date')
  })
})

describe('fidelity probe', () => {
  it('marks a style that reproduces the probe record as verified', () => {
    const outcome = importCslStyle(styleDocument({}), 'ok.csl', { hash: hasher })
    if (outcome.status !== 'imported') throw new Error('import expected')
    expect(outcome.style.fidelity).toBe('verified')
    expect(outcome.style.fidelityNotes).toEqual([])
  })

  it('marks a style that cannot reproduce the probe record as a draft, naming what is missing', () => {
    const xml = styleDocument({
      bibliography: `<bibliography>
    <layout suffix=".">
      <text variable="container-title"/>
    </layout>
  </bibliography>`
    })
    const outcome = importCslStyle(xml, 'thin.csl', { hash: hasher })
    if (outcome.status !== 'imported') throw new Error('import expected')
    expect(outcome.style.fidelity).toBe('partial')
    expect(outcome.style.fidelityNotes).toEqual([
      'missing:title',
      'missing:authors',
      'missing:year',
      'missing:pages'
    ])
    // The verdict travels with every render of that style, not only with the import.
    const style = citationStyleFromImport(outcome.style)
    const formatted = formatCitation(item(), style.id, {}, [style])
    expect(formatted.warnings).toContain('fidelity:partial')
    expect(formatted.warnings).toContain('fidelity:missing:title')
  })

  it('reports an empty render as the first thing that went wrong', () => {
    const xml = styleDocument({
      bibliography: '<bibliography><layout/></bibliography>'
    })
    const outcome = importCslStyle(xml, 'empty.csl', { hash: hasher })
    if (outcome.status !== 'imported') throw new Error('import expected')
    expect(outcome.style.fidelityNotes).toEqual(['render-empty'])
  })
})

describe('rendering an imported style', () => {
  it('formats a record through the imported bibliography layout', () => {
    const outcome = importCslStyle(styleDocument({}), 'test-journal.csl', { hash: hasher })
    if (outcome.status !== 'imported') throw new Error('import expected')
    const style = citationStyleFromImport(outcome.style)
    const formatted = formatCitation(item(), style.id, { index: 1 }, [style])
    expect(formatted.text).toBe(
      'Zhang, W., Chen, L., Smith, J. A. and Huang, M. Deep learning for protein design. Nature Methods 21, 145-158 (2024).'
    )
    // The flattened italic attribute travels with the render so the caller can say so in the UI.
    expect(formatted.warnings).toContain('unsupported:attribute:font-style')
  })

  it('renders the parts a sparse record has and names the rest', () => {
    const outcome = importCslStyle(styleDocument({}), 'test-journal.csl', { hash: hasher })
    if (outcome.status !== 'imported') throw new Error('import expected')
    const style = citationStyleFromImport(outcome.style)
    const sparse = citationItemFromReference({
      title: 'A short note',
      authors: [{ name: 'Wei Zhang' }]
    })
    const formatted = formatCitation(sparse, style.id, {}, [style])
    expect(formatted.text).toBe('Zhang, W. A short note.')
    expect(formatted.warnings).toContain('field:year')
    expect(formatted.warnings).toContain('field:containerTitle')
  })

  it('registers imported styles after the built-ins and keeps their labels', () => {
    const outcome = importCslStyle(
      styleDocument({ title: '<title>Imported Journal Style</title>' }),
      'i.csl',
      {
        hash: hasher
      }
    )
    if (outcome.status !== 'imported') throw new Error('import expected')
    const style = citationStyleFromImport(outcome.style, '导入的期刊样式')
    expect(style.label).toBe('Imported Journal Style')
    expect(style.labelZh).toBe('导入的期刊样式')
    expect(formatCitation(item(), 'csl-import:test-journal', {}, [style]).styleLabel).toBe(
      'Imported Journal Style'
    )
  })
})
