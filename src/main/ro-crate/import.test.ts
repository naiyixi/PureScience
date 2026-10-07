import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  RO_CRATE_METADATA_FILENAME,
  failedRoCrateAssertions,
  type RoCrateMetadataDocument
} from '../../shared/ro-crate'
import { writeRoCrateExport } from './export'
import { writeDurableVersion } from './export-test-fixtures'
import { inspectExternalRoCrate } from './import'

const sha256 = (bytes: Uint8Array | string): string =>
  createHash('sha256').update(bytes).digest('hex')

let scratch: string | undefined

const createScratch = async (): Promise<string> => {
  scratch = await mkdtemp(join(tmpdir(), 'external-crate-'))
  return scratch
}

afterEach(async () => {
  if (scratch) {
    await rm(scratch, { recursive: true, force: true })
    scratch = undefined
  }
})

const crateWith = async (contents: string | null): Promise<string> => {
  const dir = await createScratch()
  if (contents !== null) {
    await writeFile(join(dir, RO_CRATE_METADATA_FILENAME), contents, 'utf8')
  }
  return dir
}

/**
 * A crate this app really wrote, via the real writer over the durable provenance layout — the only input
 * that can prove the reader judges the SAME assertions the writer does. A hand-built document would let the
 * two surfaces drift apart without either test noticing.
 */
const writeRealCrate = async (
  body = 'a,b\n1,2\n'
): Promise<{ crateDir: string; payloadPaths: string[]; assertionCount: number }> => {
  const root = await createScratch()
  await writeDurableVersion({
    storageRoot: root,
    projectId: 'project-1',
    appSessionId: 'session-1',
    artifactId: 'artifact-1',
    versionId: 'version-1',
    filename: 'assay.csv',
    body,
    contentType: 'text/csv'
  })
  const crateDir = join(root, 'crate')
  const exported = await writeRoCrateExport({
    storageRoot: root,
    outputDir: crateDir,
    projectId: 'project-1',
    projectName: 'Project One',
    app: { name: 'PureScience', version: '1.75.0', url: 'https://www.zerolink.com/purescience' },
    generatedAt: '2026-09-30T00:00:00.000Z'
  })
  return {
    crateDir,
    payloadPaths: exported.files.map((file) => file.cratePath),
    assertionCount: exported.validation.assertions.length
  }
}

const namedFailures = (assertions: ReturnType<typeof failedRoCrateAssertions>): string =>
  assertions.map((assertion) => `${assertion.id}: ${assertion.detail ?? ''}`).join('\n')

describe('inspectExternalRoCrate', () => {
  it('reports the app’s own rules on a crate whose metadata parses', async () => {
    // A minimal graph that satisfies the shape rule and nothing else: the report is where the failing
    // assertions live, so this must come back as a report rather than a refusal.
    const cratePath = await crateWith(
      JSON.stringify({
        '@context': 'https://w3id.org/ro/crate/1.1/context',
        '@graph': [
          {
            '@id': 'ro-crate-metadata.json',
            '@type': 'CreativeWork',
            about: { '@id': './' }
          },
          { '@id': './', '@type': 'Dataset', name: 'External crate' }
        ]
      })
    )

    const result = await inspectExternalRoCrate(cratePath)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.metadataPath).toBe(join(cratePath, RO_CRATE_METADATA_FILENAME))
    // The report carries every assertion, passed or failed — this module does not summarise them away.
    expect(result.report.assertions.length).toBeGreaterThan(0)
    expect(result.report.passed + result.report.failed).toBe(result.report.assertions.length)
  })

  it('judges a crate this app did not write on the same assertions as the writer, payload bytes included', async () => {
    const { crateDir, assertionCount } = await writeRealCrate()

    const result = await inspectExternalRoCrate(crateDir)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    // The identical surface: reading a document without its payloads would leave three rules unjudged and
    // let this side report "every check passed" over bytes it never looked at.
    expect(result.report.assertions.length).toBe(assertionCount)
    expect(result.report.ok).toBe(true)
    expect(result.report.failed).toBe(0)
    for (const id of [
      'file-sha256-matches-copied-bytes',
      'file-content-size-matches-copied-bytes',
      'every-payload-described'
    ]) {
      expect(result.report.assertions.find((assertion) => assertion.id === id)?.ok).toBe(true)
    }
  })

  it('names the payload whose bytes no longer hash to what the document declares', async () => {
    const { crateDir, payloadPaths } = await writeRealCrate()
    await writeFile(join(crateDir, payloadPaths[0]!), 'tampered after the fact\n', 'utf8')

    const result = await inspectExternalRoCrate(crateDir)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.report.ok).toBe(false)
    const named = namedFailures(failedRoCrateAssertions(result.report))
    expect(named).toContain('file-sha256-matches-copied-bytes')
    expect(named).toContain(payloadPaths[0]!)
  })

  it('names a payload the document declares but the crate does not hold', async () => {
    const { crateDir, payloadPaths } = await writeRealCrate()
    await rm(join(crateDir, payloadPaths[0]!))

    const result = await inspectExternalRoCrate(crateDir)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const failed = failedRoCrateAssertions(result.report)
    // The absent file is named by the byte comparison (no digest to compare) and NOT as an undescribed
    // payload — the two rules answer different questions.
    expect(namedFailures(failed)).toContain('file-sha256-matches-copied-bytes')
    expect(failed.some((assertion) => assertion.id === 'every-payload-described')).toBe(false)
  })

  it('names a file in the payload folder that the document does not describe', async () => {
    const { crateDir } = await writeRealCrate()
    await writeFile(join(crateDir, 'files', 'leftover.bin'), 'nobody described me\n', 'utf8')

    const result = await inspectExternalRoCrate(crateDir)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const named = namedFailures(failedRoCrateAssertions(result.report))
    expect(named).toContain('every-payload-described')
    expect(named).toContain('files/leftover.bin')
  })

  it('never reads outside the crate, even when the document names a path that escapes it', async () => {
    const { crateDir, payloadPaths } = await writeRealCrate()
    const outside = join(crateDir, '..', 'outside.txt')
    const outsideBody = 'bytes that belong to no crate\n'
    await writeFile(outside, outsideBody, 'utf8')

    // A document that declares the escaping path with the OUTSIDE file's real digest and size. A reader that
    // followed the path would find a perfect match and report success; the assertion below is only meaningful
    // because the digest it would have found is genuinely correct.
    const document = JSON.parse(
      await readFile(join(crateDir, RO_CRATE_METADATA_FILENAME), 'utf8')
    ) as RoCrateMetadataDocument
    const escapingId = 'files/../outside.txt'
    document['@graph'].push({
      '@id': escapingId,
      '@type': 'File',
      name: 'outside',
      contentSize: String(Buffer.byteLength(outsideBody)),
      sha256: sha256(outsideBody),
      encodingFormat: 'text/plain'
    })
    await writeFile(
      join(crateDir, RO_CRATE_METADATA_FILENAME),
      `${JSON.stringify(document, null, 2)}\n`,
      'utf8'
    )

    const result = await inspectExternalRoCrate(crateDir)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const named = namedFailures(failedRoCrateAssertions(result.report))
    expect(named).toContain('file-sha256-matches-copied-bytes')
    expect(named).toContain(escapingId)
    // The crate's own payload is untouched by any of this and still passes.
    expect(named).not.toContain(payloadPaths[0]!)
  })

  // Creating a symbolic link needs privileges on Windows, so the case is skipped there by name rather than
  // silently passing: the guard it covers (never follow a link out of the crate) is the same one the
  // escaping-path case exercises on every platform.
  it.skipIf(process.platform === 'win32')(
    'does not follow a symlink planted in the payload folder',
    async () => {
      const { crateDir } = await writeRealCrate()
      const outside = join(crateDir, '..', 'elsewhere.txt')
      const outsideBody = 'linked bytes\n'
      await writeFile(outside, outsideBody, 'utf8')

      const document = JSON.parse(
        await readFile(join(crateDir, RO_CRATE_METADATA_FILENAME), 'utf8')
      ) as RoCrateMetadataDocument
      const linkedId = 'files/linked.csv'
      document['@graph'].push({
        '@id': linkedId,
        '@type': 'File',
        name: 'linked',
        contentSize: String(Buffer.byteLength(outsideBody)),
        sha256: sha256(outsideBody),
        encodingFormat: 'text/plain'
      })
      await writeFile(
        join(crateDir, RO_CRATE_METADATA_FILENAME),
        `${JSON.stringify(document, null, 2)}\n`,
        'utf8'
      )
      await symlink(outside, join(crateDir, linkedId))

      const result = await inspectExternalRoCrate(crateDir)

      expect(result.ok).toBe(true)
      if (!result.ok) return
      const named = namedFailures(failedRoCrateAssertions(result.report))
      // The digest would match if the link were followed — it must not be.
      expect(named).toContain('file-sha256-matches-copied-bytes')
      expect(named).toContain(linkedId)
    }
  )

  it('names a missing metadata document instead of reporting rules it never read', async () => {
    const cratePath = await crateWith(null)

    expect(await inspectExternalRoCrate(cratePath)).toEqual({
      ok: false,
      reason: 'no-metadata-file',
      detail: `${join(cratePath, RO_CRATE_METADATA_FILENAME)} does not exist`
    })
  })

  it('names an unparseable document rather than judging it', async () => {
    const cratePath = await crateWith('{ not json')

    const result = await inspectExternalRoCrate(cratePath)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('unparseable')
    expect(result.detail).toContain(cratePath)
  })

  it('keeps “not a crate” apart from “cannot be read right now”', async () => {
    // A directory where the metadata document should be: the read fails, but not because it is absent.
    const cratePath = await createScratch()
    await mkdir(join(cratePath, RO_CRATE_METADATA_FILENAME))

    const result = await inspectExternalRoCrate(cratePath)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('unreadable')
  })
})
