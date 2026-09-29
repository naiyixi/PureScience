import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { failedRoCrateAssertions, validateRoCrate } from '../../shared/ro-crate'
import { readRoCrateProjectVersions, writeRoCrateExport } from './export'
import { writeDurableVersion } from './export-test-fixtures'

let scratch: string | undefined

const createScratch = async (): Promise<string> => {
  scratch = await mkdtemp(join(tmpdir(), 'purescience-ro-crate-'))
  return scratch
}

afterEach(async () => {
  if (scratch) {
    await rm(scratch, { recursive: true, force: true })
    scratch = undefined
  }
})

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')
const sha256Bytes = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

const APP = { name: 'PureScience', version: '1.75.0', url: 'https://www.zerolink.com/purescience' }

describe('RO-Crate export from durable provenance storage', () => {
  it('exports every published Version with its recorded hash, and nothing else', async () => {
    const storageRoot = await createScratch()
    await writeDurableVersion({
      storageRoot,
      projectId: 'project-1',
      appSessionId: 'session-1',
      artifactId: 'artifact-1',
      versionId: 'version-1',
      filename: 'assay.csv',
      body: 'a,b\n1,2\n',
      contentType: 'text/csv',
      agentName: 'Agent'
    })
    await writeDurableVersion({
      storageRoot,
      projectId: 'project-1',
      appSessionId: 'session-2',
      artifactId: 'artifact-2',
      versionId: 'version-2',
      filename: 'figure.png',
      body: 'PNGDATA',
      contentType: 'image/png'
    })

    const outputDir = join(storageRoot, 'crate')
    const result = await writeRoCrateExport({
      storageRoot,
      outputDir,
      projectId: 'project-1',
      projectName: 'Project One',
      app: APP,
      generatedAt: '2026-09-30T00:00:00.000Z'
    })

    expect(result.files.map((file) => file.cratePath)).toEqual([
      'files/assay.csv',
      'files/figure.png'
    ])
    expect(result.skipped).toEqual([])
    expect(result.validation.ok).toBe(true)
    expect(failedRoCrateAssertions(result.validation)).toEqual([])

    // The payload on disk is byte-identical to the stored Version and hashes to the declared value.
    const copied = await readFile(join(outputDir, 'files/assay.csv'), 'utf8')
    expect(copied).toBe('a,b\n1,2\n')
    const written = await readFile(join(outputDir, 'ro-crate-metadata.json'), 'utf8')
    expect(written.endsWith('\n')).toBe(true)
    const parsed = JSON.parse(written) as { '@graph': { '@id': string; sha256?: string }[] }
    expect(parsed['@graph'].find((entity) => entity['@id'] === 'files/assay.csv')?.sha256).toBe(
      sha256('a,b\n1,2\n')
    )
  })

  it('validates its own output against the copied bytes, not against the record it read', async () => {
    const storageRoot = await createScratch()
    await writeDurableVersion({
      storageRoot,
      projectId: 'project-1',
      appSessionId: 'session-1',
      artifactId: 'artifact-1',
      versionId: 'version-1',
      filename: 'assay.csv',
      body: 'a,b\n1,2\n'
    })
    const outputDir = join(storageRoot, 'crate')
    const result = await writeRoCrateExport({
      storageRoot,
      outputDir,
      projectId: 'project-1',
      app: APP,
      generatedAt: '2026-09-30T00:00:00.000Z'
    })
    // Re-validating from scratch (metadata + bytes on disk) reproduces the writer's own verdict.
    const digests = new Map(
      await Promise.all(
        result.files.map(async (file) => {
          const bytes = await readFile(join(outputDir, file.cratePath))
          return [
            file.cratePath,
            { sizeBytes: bytes.byteLength, sha256: sha256Bytes(bytes) }
          ] as const
        })
      )
    )
    const revalidated = validateRoCrate({
      document: JSON.parse(await readFile(result.metadataPath, 'utf8')),
      payloadPaths: result.files.map((file) => file.cratePath),
      payloadDigests: digests
    })
    expect(revalidated.ok).toBe(true)
  })

  it('refuses to export a Version whose bytes no longer match its recorded checksum', async () => {
    const storageRoot = await createScratch()
    await writeDurableVersion({
      storageRoot,
      projectId: 'project-1',
      appSessionId: 'session-1',
      artifactId: 'artifact-1',
      versionId: 'version-good',
      filename: 'good.csv',
      body: 'good\n'
    })
    await writeDurableVersion({
      storageRoot,
      projectId: 'project-1',
      appSessionId: 'session-1',
      artifactId: 'artifact-2',
      versionId: 'version-corrupt',
      filename: 'corrupt.csv',
      body: 'original\n',
      corruptBytes: 'tampered\n'
    })

    const result = await writeRoCrateExport({
      storageRoot,
      outputDir: join(storageRoot, 'crate'),
      projectId: 'project-1',
      app: APP,
      generatedAt: '2026-09-30T00:00:00.000Z'
    })

    expect(result.files.map((file) => file.cratePath)).toEqual(['files/good.csv'])
    expect(result.skipped).toEqual([
      {
        projectId: 'project-1',
        appSessionId: 'session-1',
        artifactId: 'artifact-2',
        versionId: 'version-corrupt',
        reason: 'checksum-mismatch'
      }
    ])
    await expect(stat(join(result.outputDir, 'files/corrupt.csv'))).rejects.toThrow()
  })

  it('never exports a Version that was left in .staging (never published)', async () => {
    const storageRoot = await createScratch()
    await writeDurableVersion({
      storageRoot,
      projectId: 'project-1',
      appSessionId: 'session-1',
      artifactId: 'artifact-1',
      versionId: 'version-published',
      filename: 'published.csv',
      body: 'published\n'
    })
    await writeDurableVersion({
      storageRoot,
      projectId: 'project-1',
      appSessionId: 'session-1',
      artifactId: 'artifact-2',
      versionId: 'version-staged',
      filename: 'staged.csv',
      body: 'staged\n',
      staged: true
    })

    const { versions, skipped } = await readRoCrateProjectVersions({
      storageRoot,
      projectId: 'project-1'
    })
    expect(versions.map((version) => version.versionId)).toEqual(['version-published'])
    expect(skipped).toEqual([])

    const result = await writeRoCrateExport({
      storageRoot,
      outputDir: join(storageRoot, 'crate'),
      projectId: 'project-1',
      app: APP,
      generatedAt: '2026-09-30T00:00:00.000Z'
    })
    expect(result.files.map((file) => file.cratePath)).toEqual(['files/published.csv'])
  })

  it('reports a missing content file instead of exporting an empty copy', async () => {
    const storageRoot = await createScratch()
    await writeDurableVersion({
      storageRoot,
      projectId: 'project-1',
      appSessionId: 'session-1',
      artifactId: 'artifact-1',
      versionId: 'version-1',
      filename: 'gone.csv',
      body: 'gone\n',
      omitContent: true
    })
    const { versions, skipped } = await readRoCrateProjectVersions({
      storageRoot,
      projectId: 'project-1'
    })
    expect(versions).toEqual([])
    expect(skipped.map((entry) => entry.reason)).toEqual(['content-missing'])
  })

  it('refuses a Project with no published Version, rather than writing an empty crate', async () => {
    const storageRoot = await createScratch()
    await expect(
      writeRoCrateExport({
        storageRoot,
        outputDir: join(storageRoot, 'crate'),
        projectId: 'project-1',
        app: APP
      })
    ).rejects.toThrow(/no published Artifact Version/)
  })

  it('rejects a project id that could escape the storage root', async () => {
    const storageRoot = await createScratch()
    await expect(
      readRoCrateProjectVersions({ storageRoot, projectId: '../escape' })
    ).rejects.toThrow(/Unsafe project id/)
  })

  it('records each file\u2019s Artifact Version locator so the copy can be traced back', async () => {
    const storageRoot = await createScratch()
    await writeDurableVersion({
      storageRoot,
      projectId: 'project-1',
      appSessionId: 'session-1',
      artifactId: 'artifact-1',
      versionId: 'version-1',
      filename: 'assay.csv',
      body: 'a,b\n'
    })
    const result = await writeRoCrateExport({
      storageRoot,
      outputDir: join(storageRoot, 'crate'),
      projectId: 'project-1',
      app: APP,
      generatedAt: '2026-09-30T00:00:00.000Z'
    })
    const file = result.metadata['@graph'].find((entity) => entity['@id'] === 'files/assay.csv')
    expect(file?.['identifier']).toBe('artifact-version:project-1/session-1/artifact-1/version-1')
    // The locator is the app's own; it resolves back to the exact bytes we copied.
    const sourcePath = join(
      storageRoot,
      'artifacts/project-1/session-1/.provenance/artifact-1/versions/version-1/content'
    )
    expect(await readFile(sourcePath, 'utf8')).toBe(
      await readFile(join(result.outputDir, 'files/assay.csv'), 'utf8')
    )
  })
})
