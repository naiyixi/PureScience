import { describe, expect, it } from 'vitest'

import { BUILTIN_CITATION_STYLES } from '../../shared/citation/builtin-styles'
import { citationStyleFromImport } from '../../shared/citation/csl'
import { citationItemFromReference, formatCitation } from '../../shared/citation/format'
import { citationStyleDocumentHash, CitationStyleService } from './citation-style-service'
import {
  CitationStyleRepository,
  type CitationStyleClient,
  type StoredCitationStyleRow
} from './citation-style-repository'

const styleXml = (options: { id?: string; title?: string; rights?: string } = {}): string =>
  `<style xmlns="http://purl.org/net/xbiblio/csl" version="1.0">
  <info>
    <title>${options.title ?? 'Fixture Journal'}</title>
    <id>${options.id ?? 'http://example.org/styles/fixture'}</id>
    <updated>2026-02-03T00:00:00+00:00</updated>
    <rights license="${options.rights ?? 'https://creativecommons.org/licenses/by-sa/3.0/'}">CC BY-SA 3.0</rights>
  </info>
  <citation><layout><text variable="citation-number" prefix="[" suffix="]"/></layout></citation>
  <bibliography>
    <layout suffix=".">
      <names variable="author"><name and="text" initialize-with=". " delimiter=", "/></names>
      <text variable="title" prefix=" " suffix="."/>
      <date variable="issued" prefix=" (" suffix=")"><date-part name="year"/></date>
    </layout>
  </bibliography>
</style>`

// In-memory stand-in for the Prisma delegate: proves the repository's storage contract (upsert by
// styleId, ordered list, deleteMany) without an engine. The delegate surface is cast because the
// repository only ever calls these three methods.
const createMemoryClient = (): {
  rows: Map<string, StoredCitationStyleRow>
  client: CitationStyleClient
} => {
  const rows = new Map<string, StoredCitationStyleRow>()
  let seq = 0
  return {
    rows,
    client: {
      citationStyle: {
        findMany: async () =>
          [...rows.values()].sort((a, b) => a.importedAt.getTime() - b.importedAt.getTime()),
        upsert: async ({
          where,
          create,
          update
        }: {
          where: { styleId: string }
          create: Omit<StoredCitationStyleRow, 'id'>
          update: Omit<StoredCitationStyleRow, 'id'>
        }) => {
          const existing = rows.get(where.styleId)
          const next: StoredCitationStyleRow = {
            id: existing?.id ?? `row-${++seq}`,
            ...(existing ? update : create)
          }
          rows.set(where.styleId, next)
          return next
        },
        deleteMany: async ({ where }: { where: { styleId: string } }) => {
          const had = rows.delete(where.styleId)
          return { count: had ? 1 : 0 }
        }
      }
    } as unknown as CitationStyleClient
  }
}

const createService = (): {
  service: CitationStyleService
  memory: ReturnType<typeof createMemoryClient>
} => {
  const memory = createMemoryClient()
  const repository = new CitationStyleRepository(async () => memory.client)
  return { service: new CitationStyleService(repository), memory }
}

describe('citation style import', () => {
  it('stores an accepted style with its licence, hash and compiled program', async () => {
    const { service, memory } = createService()
    const xml = styleXml()
    const outcome = await service.importStyle({ fileName: 'fixture.csl', xml })
    expect(outcome.status).toBe('imported')
    if (outcome.status !== 'imported') return
    expect(outcome.replacedExisting).toBe(false)
    expect(outcome.style.id).toBe('csl-import:fixture')
    expect(outcome.style.license).toContain('creativecommons.org')
    expect(outcome.style.contentHash).toBe(citationStyleDocumentHash(xml))
    expect(outcome.style.program.layout.length).toBeGreaterThan(0)
    expect(memory.rows.size).toBe(1)
  })

  it('replaces the stored copy when the same style is imported again', async () => {
    const { service, memory } = createService()
    await service.importStyle({ fileName: 'fixture.csl', xml: styleXml() })
    const again = await service.importStyle({
      fileName: 'fixture-v2.csl',
      xml: styleXml({ title: 'Fixture Journal' })
    })
    expect(again.status).toBe('imported')
    if (again.status !== 'imported') return
    expect(again.replacedExisting).toBe(true)
    expect(again.style.fileName).toBe('fixture-v2.csl')
    expect(memory.rows.size).toBe(1)
  })

  it('refuses a style with no licence and stores nothing', async () => {
    const { service, memory } = createService()
    const outcome = await service.importStyle({
      fileName: 'unattributed.csl',
      xml: `<style><info><title>No licence</title></info><bibliography><layout/></bibliography></style>`
    })
    expect(outcome).toEqual({ status: 'rejected', reason: 'missing-license' })
    expect(memory.rows.size).toBe(0)
  })

  it('refuses a document that would shadow a built-in style id', async () => {
    const { service } = createService()
    // The built-in ids are the collision set: a document claiming one of them is refused at import.
    expect(BUILTIN_CITATION_STYLES.map((style) => style.id)).toContain('gbt7714-2015')
    const outcome = await service.importStyle({
      fileName: 'gov.csl',
      xml: styleXml({ id: 'http://example.org/styles/gbt7714-2015' })
    })
    expect(outcome.status).toBe('imported')
    if (outcome.status !== 'imported') return
    // The import namespace keeps an imported style from ever taking a built-in id.
    expect(outcome.style.id.startsWith('csl-import:')).toBe(true)
    expect(BUILTIN_CITATION_STYLES.map((style) => style.id)).not.toContain(outcome.style.id)
  })

  it('refuses an oversized document before parsing it', async () => {
    const { service, memory } = createService()
    const outcome = await service.importStyle({
      fileName: 'huge.csl',
      xml: `<!--${'x'.repeat(2 * 1024 * 1024 + 1)}-->`
    })
    expect(outcome).toEqual({ status: 'rejected', reason: 'too-large' })
    expect(memory.rows.size).toBe(0)
  })

  it('lists stored styles in import order and removes one by id', async () => {
    const { service } = createService()
    await service.importStyle({ fileName: 'a.csl', xml: styleXml({ id: 'http://e/a' }) })
    await service.importStyle({ fileName: 'b.csl', xml: styleXml({ id: 'http://e/b' }) })
    const listed = await service.listStyles()
    expect(listed.map((style) => style.id)).toEqual(['csl-import:a', 'csl-import:b'])
    await service.removeStyle('csl-import:a')
    expect((await service.listStyles()).map((style) => style.id)).toEqual(['csl-import:b'])
  })
})

// A stored program is compiled once, at import: if the locale's date format is not resolved there,
// every render of that style afterwards is stuck with whatever the compile chose. So the format
// has to survive the round trip through the store, not only exist in the shared module.
describe('stored date formats', () => {
  it('keeps the resolved locale date format in the stored program and renders with it', async () => {
    const { service } = createService()
    const xml = `<style xmlns="http://purl.org/net/xbiblio/csl" version="1.0" default-locale="zh-CN">
  <info>
    <title>Zh date style</title>
    <id>http://example.org/styles/zh-date</id>
    <rights license="https://creativecommons.org/licenses/by-sa/3.0/">CC BY-SA 3.0</rights>
  </info>
  <citation><layout><text variable="citation-number"/></layout></citation>
  <bibliography>
    <layout suffix=".">
      <text variable="title" suffix=". 引用日期："/>
      <date variable="accessed" form="text"/>
    </layout>
  </bibliography>
</style>`
    const outcome = await service.importStyle({ fileName: 'zh-date.csl', xml })
    expect(outcome.status).toBe('imported')
    if (outcome.status !== 'imported') return
    const style = citationStyleFromImport(outcome.style)
    const formatted = formatCitation(
      citationItemFromReference({
        title: '中文条目',
        authors: [{ name: '李航' }],
        year: 2012,
        itemType: 'book'
      }),
      style.id,
      { retrievedAt: '2026-11-21' },
      [style]
    )
    expect(formatted.text).toContain('2026年11月21日')
    expect(outcome.style.unsupported).not.toContain('date:default-year')
  })
})
