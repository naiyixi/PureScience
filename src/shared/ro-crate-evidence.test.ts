// The committed RO-Crate evidence must prove itself, in CI, with no network and no live data root:
// this suite re-reads `docs/evidence/*-ro-crate-metadata.json` and re-runs the same compliance
// assertions the exporter ran, cross-checked against the capture's own report. It is the machine
// answer to "show me the crate you exported is a valid RO-Crate 1.1", and it fails if the committed
// metadata is edited without re-running the capture.

import { readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  RO_CRATE_CONTEXT_URL,
  RO_CRATE_METADATA_FILENAME,
  RO_CRATE_PROFILE_URL,
  RO_CRATE_ROOT_DATASET_ID,
  failedRoCrateAssertions,
  validateRoCrate,
  type RoCrateMetadataDocument,
  type RoCratePayloadDigest,
  type RoCrateValidationReport
} from './ro-crate'

const EVIDENCE_DIR = resolve(process.cwd(), 'docs', 'evidence')

type CaptureFileEntry = {
  cratePath: string
  appSessionId: string
  artifactId: string
  versionId: string
  sizeBytes: number
  sha256: string
}

type CaptureReport = {
  generator: string
  source: { storageRoot: string; projectId: string; publishedVersionCount: number }
  files: CaptureFileEntry[]
  validation: RoCrateValidationReport
}

const metadataFiles = async (): Promise<string[]> =>
  (await readdir(EVIDENCE_DIR)).filter((name) => name.endsWith('-ro-crate-metadata.json')).sort()

const loadPair = async (
  metadataName: string
): Promise<{ document: RoCrateMetadataDocument; report: CaptureReport }> => {
  const document = JSON.parse(
    await readFile(join(EVIDENCE_DIR, metadataName), 'utf8')
  ) as RoCrateMetadataDocument
  const reportName = metadataName.replace('-ro-crate-metadata.json', '-ro-crate-validation.json')
  const report = JSON.parse(await readFile(join(EVIDENCE_DIR, reportName), 'utf8')) as CaptureReport
  return { document, report }
}

const digestsFromReport = (report: CaptureReport): Map<string, RoCratePayloadDigest> =>
  new Map(
    report.files.map((file) => [file.cratePath, { sizeBytes: file.sizeBytes, sha256: file.sha256 }])
  )

describe('committed RO-Crate 1.1 evidence', () => {
  it('ships at least one real exported crate', async () => {
    const names = await metadataFiles()
    expect(names.length).toBeGreaterThan(0)
  })

  it('re-validates the committed metadata against the capture report, rule by rule', async () => {
    const names = await metadataFiles()
    expect(names.length).toBeGreaterThan(0)

    for (const name of names) {
      const { document, report } = await loadPair(name)

      // 1. The capture recorded a clean run, and every assertion it recorded passed.
      expect(report.validation.ok).toBe(true)
      expect(report.validation.failed).toBe(0)
      expect(report.validation.assertions.length).toBeGreaterThan(10)
      expect(report.validation.assertions.filter((assertion) => !assertion.ok)).toEqual([])
      expect(report.generator).toBe('src/main/ro-crate/export.ts#writeRoCrateExport')

      // 2. The document still passes every decidable rule today, and its references all resolve.
      const revalidated = validateRoCrate({
        document,
        payloadPaths: report.files.map((file) => file.cratePath)
      })
      expect(failedRoCrateAssertions(revalidated)).toEqual([])
      expect(revalidated.ok).toBe(true)

      // 3. Byte-level rules hold too, judged against the digests the export measured on the copies.
      const withDigests = validateRoCrate({
        document,
        payloadPaths: report.files.map((file) => file.cratePath),
        payloadDigests: digestsFromReport(report)
      })
      expect(failedRoCrateAssertions(withDigests)).toEqual([])

      // 4. Metadata and report agree file by file: same set, same checksum, same size.
      const fileEntities = document['@graph'].filter((entity) => entity['@type'] === 'File')
      expect(fileEntities.map((entity) => entity['@id']).sort()).toEqual(
        report.files.map((file) => file.cratePath).sort()
      )
      for (const file of report.files) {
        const entity = fileEntities.find((candidate) => candidate['@id'] === file.cratePath)
        expect(entity?.['sha256']).toBe(file.sha256)
        expect(entity?.['contentSize']).toBe(String(file.sizeBytes))
        // The locator is the app's own Artifact Version identity, spelled out field by field.
        expect(entity?.['identifier']).toBe(
          `artifact-version:${report.source.projectId}/${file.appSessionId}/${file.artifactId}/${file.versionId}`
        )
      }
    }
  })

  it('describes the crate with the entity types an interoperable reader needs', async () => {
    const names = await metadataFiles()
    for (const name of names) {
      const { document, report } = await loadPair(name)

      expect(document['@context'][0]).toBe(RO_CRATE_CONTEXT_URL)

      const descriptor = document['@graph'].find(
        (entity) => entity['@id'] === RO_CRATE_METADATA_FILENAME
      )
      expect(descriptor?.['@type']).toBe('CreativeWork')
      expect(descriptor?.['conformsTo']).toEqual({ '@id': RO_CRATE_PROFILE_URL })

      const root = document['@graph'].find((entity) => entity['@id'] === RO_CRATE_ROOT_DATASET_ID)
      expect(root?.['@type']).toBe('Dataset')

      const types = new Set(
        document['@graph'].flatMap((entity) =>
          Array.isArray(entity['@type']) ? entity['@type'] : [entity['@type']]
        )
      )
      // Dataset/File/SoftwareApplication/CreativeWork come from the graph itself; Organization is
      // asserted only when the export declared a publisher.
      expect(types.has('Dataset')).toBe(true)
      expect(types.has('File')).toBe(true)
      expect(types.has('SoftwareApplication')).toBe(true)
      expect(types.has('CreativeWork')).toBe(true)

      // Every payload names the stored Artifact Version it was copied from — the traceability claim.
      const actions = document['@graph'].filter((entity) => entity['@type'] === 'CreateAction')
      expect(actions.length).toBe(report.files.length)
      for (const action of actions) {
        expect(typeof action['identifier']).toBe('string')
        expect(String(action['identifier']).startsWith('artifact-version:')).toBe(true)
      }
    }
  })
})
