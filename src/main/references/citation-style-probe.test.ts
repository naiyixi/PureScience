import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { citationStyleFromImport } from '../../shared/citation/csl'
import { formatCitation } from '../../shared/citation/format'
import { citationItemFromReference } from '../../shared/citation/format'
import { createProjectDbClient, ensureProjectSchema } from '../projects/prisma-client'
import { CitationStyleRepository } from './citation-style-repository'
import { CitationStyleService } from './citation-style-service'

// One-off real-data probe (not a fixture test): a real SQLite database created by the app's own
// schema bootstrap, driven through the citation-style service, importing real CSL documents from a
// locally installed workbench. The directory comes from the environment so no third-party product
// name or install path is committed; without it the probe skips.
const CSL_DIR = process.env.PURESCIENCE_CSL_PROBE_DIR ?? ''

const available = CSL_DIR !== '' && existsSync(CSL_DIR)

describe.skipIf(!available)(
  'citation styles against a real database and real CSL documents',
  () => {
    it('imports, persists, renders and removes', async () => {
      const storageRoot = await mkdtemp(join(tmpdir(), 'purescience-citation-probe-'))
      const client = createProjectDbClient(storageRoot)
      await ensureProjectSchema(client)
      const service = new CitationStyleService(
        new CitationStyleRepository(async () => client as never)
      )

      const files = readdirSync(CSL_DIR)
        .filter((name) => name.endsWith('.csl'))
        .sort()
      console.log(`[probe] data root: ${storageRoot}`)
      console.log(`[probe] real CSL documents: ${files.length}`)

      const reference = citationItemFromReference({
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
        issue: '3',
        pages: '145-158',
        doi: '10.1038/s41592-024-01234-5',
        itemType: 'journal-article'
      })

      const imported: string[] = []
      for (const file of files) {
        const xml = readFileSync(join(CSL_DIR, file), 'utf8')
        const outcome = await service.importStyle({ fileName: file, xml })
        if (outcome.status !== 'imported') {
          console.log(`[probe] ${file}: REJECTED ${outcome.reason} ${outcome.detail ?? ''}`)
          continue
        }
        imported.push(outcome.style.id)
        const style = citationStyleFromImport(outcome.style)
        const rendered = formatCitation(reference, style.id, { index: 1 }, [style])
        console.log(
          `[probe] ${file}\n        id=${outcome.style.id}\n        licence=${outcome.style.license}\n` +
            `        fidelity=${outcome.style.fidelity}${outcome.style.fidelityNotes.length ? ` (${outcome.style.fidelityNotes.join(', ')})` : ''}\n` +
            `        unsupported=${outcome.style.unsupported.length ? outcome.style.unsupported.join(', ') : '(none)'}\n` +
            `        render=${JSON.stringify(rendered.text).slice(0, 220)}`
        )
      }

      // Persistence proof: the rows really are in the database file, not only in memory.
      const rows = await client.citationStyle.findMany({ orderBy: { importedAt: 'asc' } })
      console.log(
        `[probe] rows in CitationStyle table: ${rows.length} / imported: ${imported.length}`
      )
      console.log(`[probe] table columns: ${Object.keys(rows[0] ?? {}).join(', ')}`)
      expect(rows).toHaveLength(imported.length)

      // Re-import replaces in place instead of stacking a duplicate.
      const again = await service.importStyle({
        fileName: files[0],
        xml: readFileSync(join(CSL_DIR, files[0]), 'utf8')
      })
      expect(again.status).toBe('imported')
      if (again.status === 'imported') {
        console.log(`[probe] re-import replacedExisting=${again.replacedExisting}`)
        expect(again.replacedExisting).toBe(true)
      }
      expect(await client.citationStyle.count()).toBe(imported.length)

      // Removal leaves the rest intact.
      await service.removeStyle(imported[0])
      expect(await client.citationStyle.count()).toBe(imported.length - 1)
      console.log(`[probe] after removal: ${await client.citationStyle.count()} rows`)
      await client.$disconnect()
    }, 60_000)
  }
)
