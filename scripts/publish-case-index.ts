// Publishing side (run manually, not shipped): export a real case, pack it, and write the index document that names
// it. The output directory is exactly what gets uploaded as release assets.
import { createHash } from 'node:crypto'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { CASE_MARKETPLACE_FORMAT, CASE_MARKETPLACE_VERSION } from '../src/shared/case-marketplace'
import { exportCaseBundle } from '../src/main/cases/export-bundle'
import { packCaseArchive } from '../src/main/cases/marketplace'

const OUT = '/tmp/case-market'
const RELEASE_BASE = 'https://github.com/naiyixi/PureScience/releases/download/case-index'

const main = async (): Promise<void> => {
  const input = JSON.parse(await readFile(process.argv[2]!, 'utf8')) as {
    id: string
    caseName: string
    domain: string
    summary: string
    author: string
    license: string
    files: Array<{ name: string; sourcePath: string }>
  }
  await mkdir(OUT, { recursive: true })

  const exported = await exportCaseBundle({
    caseName: input.caseName,
    domain: input.domain,
    destinationDir: join(OUT, 'bundles'),
    files: input.files
  })
  if (!exported.ok) throw new Error(`export refused: ${exported.problem} ${exported.detail ?? ''}`)
  console.log('EXPORTED', exported.bundleDir, exported.fileCount, exported.totalBytes)

  const archiveBase = `${input.id}.tar.gz`
  const packed = await packCaseArchive(exported.bundleDir, join(OUT, archiveBase))
  if (!packed.ok) throw new Error(`pack refused: ${packed.problem}`)

  const index = {
    format: CASE_MARKETPLACE_FORMAT,
    version: CASE_MARKETPLACE_VERSION,
    updatedAt: Date.now(),
    cases: [
      {
        id: input.id,
        name: input.caseName,
        domain: input.domain,
        summary: input.summary,
        author: input.author,
        license: input.license,
        bundleUrl: `${RELEASE_BASE}/${archiveBase}`,
        bundleSha256: packed.sha256,
        fileCount: exported.fileCount,
        totalBytes: exported.totalBytes,
        publishedAt: Date.now()
      }
    ]
  }
  await writeFile(join(OUT, 'case-marketplace.json'), `${JSON.stringify(index, null, 2)}\n`, 'utf8')
  // The digest the release notes carry, so a human can check the asset they downloaded.
  const fileDigest = createHash('sha256')
    .update(await readFile(join(OUT, archiveBase)))
    .digest('hex')
  console.log(
    'ARCHIVE',
    archiveBase,
    fileDigest,
    fileDigest === packed.sha256 ? 'matches' : 'MISMATCH'
  )
  console.log('INDEX', join(OUT, 'case-marketplace.json'))
}

void main()
