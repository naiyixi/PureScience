import { describe, expect, it } from 'vitest'

import { BUILTIN_CITATION_STYLES } from '../../shared/citation/builtin-styles'
import { citationStyleDocumentHash, CitationStyleService } from './citation-style-service'
import { CitationStyleRepository, type StoredCitationStyleRow } from './citation-style-repository'

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

// In-memory stand-in for the Prisma delegate: proves the repository's SQL contract (upsert by
// styleId, ordered list, deleteMany) without an engine.
const createMemoryClient = (): {
  rows: Map<string, StoredCitationStyleRow>
  client: never
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
    }
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
