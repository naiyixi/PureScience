// Live RO-Crate export evidence capture.
//
// Skipped by default: it reads a REAL local data root (`~/PureScience-DEV` unless overridden) and
// writes the crate metadata plus the export's own validation report into `docs/evidence/`. Enable it
// deliberately, on a machine that has local Projects:
//
//   PURESCIENCE_RO_CRATE_EVIDENCE=1 \
//   PURESCIENCE_RO_CRATE_PROJECT=<projectId> \
//   [PURESCIENCE_RO_CRATE_STORAGE_ROOT=/abs/path] \
//   [PURESCIENCE_RO_CRATE_EVIDENCE_DATE=YYYY-MM-DD] \
//   npx vitest run src/main/ro-crate/evidence.capture.test.ts
//
// Nothing is invented: the metadata is whatever `writeRoCrateExport` produced from the durable
// `.provenance` records on that machine, and the report is that same call's validation verdict. The
// payload files themselves stay in a temporary crate and are not committed (they are research data);
// their checksums, sizes and Version identities are.

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { writeRoCrateExport } from './export'
import { failedRoCrateAssertions, validateRoCrate } from '../../shared/ro-crate'

const ENABLED = process.env.PURESCIENCE_RO_CRATE_EVIDENCE === '1'
const STORAGE_ROOT =
  process.env.PURESCIENCE_RO_CRATE_STORAGE_ROOT ?? join(process.env.HOME ?? '', 'PureScience-DEV')
const PROJECT_ID = process.env.PURESCIENCE_RO_CRATE_PROJECT ?? ''
const EVIDENCE_DATE = process.env.PURESCIENCE_RO_CRATE_EVIDENCE_DATE ?? localDate()

function localDate(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}
const EVIDENCE_DIR = resolve(process.cwd(), 'docs', 'evidence')

// The only transformation applied to the committed copy: the local home directory becomes `~`. The
// crate itself is written verbatim (a recorded recipe legitimately names the machine path the run
// used); the committed evidence stays reproducible without publishing one developer's home path.
// Hashes, sizes, Version identities and timestamps are untouched, so every assertion still holds.
const HOME_PREFIX = process.env.HOME ?? ''
const redactHome = <Value>(value: Value): Value =>
  HOME_PREFIX ? (JSON.parse(JSON.stringify(value).split(HOME_PREFIX).join('~')) as Value) : value

describe.skipIf(!ENABLED)('live RO-Crate export evidence capture', () => {
  it('exports a real local Project and records the crate plus its validation verdict', async () => {
    expect(PROJECT_ID, 'PURESCIENCE_RO_CRATE_PROJECT must name a real project id').not.toBe('')

    const appVersion = JSON.parse(await readFile(resolve(process.cwd(), 'package.json'), 'utf8'))
      .version as string

    const outputDir = await mkdtemp(join(tmpdir(), 'purescience-ro-crate-evidence-'))
    try {
      const result = await writeRoCrateExport({
        storageRoot: STORAGE_ROOT,
        outputDir,
        projectId: PROJECT_ID,
        app: {
          name: 'PureScience',
          version: appVersion,
          url: 'https://www.zerolink.com/purescience'
        },
        publisher: {
          type: 'Organization',
          id: 'https://www.zerolink.com',
          name: 'zerolink'
        },
        license: { id: 'https://spdx.org/licenses/Apache-2.0', name: 'Apache License 2.0' }
      })

      expect(result.validation.ok).toBe(true)
      expect(result.files.length).toBeGreaterThan(0)

      const metadataPath = join(EVIDENCE_DIR, `${EVIDENCE_DATE}-ro-crate-metadata.json`)
      const reportPath = join(EVIDENCE_DIR, `${EVIDENCE_DATE}-ro-crate-validation.json`)
      await writeFile(metadataPath, `${JSON.stringify(redactHome(result.metadata), null, 2)}\n`)
      await writeFile(
        reportPath,
        `${JSON.stringify(
          redactHome({
            generatedAt: new Date().toISOString(),
            generator: 'src/main/ro-crate/export.ts#writeRoCrateExport',
            app: { name: 'PureScience', version: appVersion },
            source: {
              storageRoot: STORAGE_ROOT,
              projectId: PROJECT_ID,
              publishedVersionCount: result.files.length,
              migratedFrom:
                'artifacts/<projectId>/<sessionId>/.provenance/<artifactId>/versions/<versionId>'
            },
            skipped: result.skipped,
            files: result.files,
            validation: result.validation
          }),
          null,
          2
        )}\n`
      )
      // The committed copy must still validate exactly as the exporter left it.
      const reRead = JSON.parse(await readFile(metadataPath, 'utf8')) as typeof result.metadata
      expect(
        failedRoCrateAssertions(
          validateRoCrate({
            document: reRead,
            payloadPaths: result.files.map((file) => file.cratePath),
            payloadDigests: new Map(
              result.files.map((file) => [
                file.cratePath,
                { sizeBytes: file.sizeBytes, sha256: file.sha256 }
              ])
            )
          })
        )
      ).toEqual([])
    } finally {
      await rm(outputDir, { recursive: true, force: true })
    }
  })
})
