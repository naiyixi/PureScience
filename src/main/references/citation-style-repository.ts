import type { PrismaClient } from '@prisma/client'

import type { ImportedCitationStyle } from '../../shared/citation/csl'
import type { CslProgram } from '../../shared/citation/csl'

// Storage for imported citation styles (v1.65). Styles are application-wide formatting assets, so
// the table carries no projectId; the row keeps the whole compiled program plus the provenance of
// the document it came from, and the styleId is unique so re-importing updates in place.
//
// Only the delegate this repository needs is typed, so it is unit-testable with a lightweight mock
// instead of a real (engine-backed) PrismaClient — the same seam the reference repository uses.
export type CitationStyleClient = Pick<PrismaClient, 'citationStyle'>
type CitationStyleClientProvider = () => Promise<CitationStyleClient>

export type StoredCitationStyleRow = {
  id: string
  styleId: string
  label: string
  license: string
  sourceUrl: string | null
  styleUpdatedAt: string | null
  defaultLocale: string | null
  contentHash: string
  fileName: string
  unsupportedJson: string
  programJson: string
  importedAt: Date
}

const parseJson = <T>(value: string): T | undefined => {
  try {
    return JSON.parse(value) as T
  } catch {
    return undefined
  }
}

export const mapCitationStyle = (row: StoredCitationStyleRow): ImportedCitationStyle => ({
  id: row.styleId,
  label: row.label,
  license: row.license,
  sourceUrl: row.sourceUrl ?? undefined,
  updated: row.styleUpdatedAt ?? undefined,
  defaultLocale: row.defaultLocale ?? undefined,
  contentHash: row.contentHash,
  fileName: row.fileName,
  importedAt: row.importedAt.getTime(),
  unsupported: parseJson<string[]>(row.unsupportedJson) ?? [],
  program: parseJson<CslProgram>(row.programJson) ?? { layout: [], locale: 'en-US' }
})

export class CitationStyleRepository {
  constructor(private readonly getClient: CitationStyleClientProvider) {}

  async listStyles(): Promise<ImportedCitationStyle[]> {
    const client = await this.getClient()
    const rows = (await client.citationStyle.findMany({
      orderBy: { importedAt: 'asc' }
    })) as StoredCitationStyleRow[]
    return rows.map(mapCitationStyle)
  }

  // Upsert by styleId: re-importing the same document replaces the stored copy (and its provenance)
  // rather than stacking duplicates the picker would have to disambiguate.
  async saveStyle(style: ImportedCitationStyle): Promise<ImportedCitationStyle> {
    const client = await this.getClient()
    const data = {
      label: style.label,
      license: style.license,
      sourceUrl: style.sourceUrl ?? null,
      styleUpdatedAt: style.updated ?? null,
      defaultLocale: style.defaultLocale ?? null,
      contentHash: style.contentHash,
      fileName: style.fileName,
      unsupportedJson: JSON.stringify(style.unsupported),
      programJson: JSON.stringify(style.program),
      importedAt: new Date(style.importedAt)
    }
    const row = (await client.citationStyle.upsert({
      where: { styleId: style.id },
      create: { styleId: style.id, ...data },
      update: data
    })) as StoredCitationStyleRow
    return mapCitationStyle(row)
  }

  async removeStyle(styleId: string): Promise<void> {
    const client = await this.getClient()
    await client.citationStyle.deleteMany({ where: { styleId } })
  }
}
