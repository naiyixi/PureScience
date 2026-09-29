import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { PdfAnnotationAnchorRequest } from '../../shared/pdf-annotation-surface'
import {
  createInMemoryPdfAnnotationStore,
  type InMemoryPdfAnnotationStore
} from '../../../test/fixtures/in-memory-pdf-annotation-client'
import {
  annotatedPdfFixture,
  plainPdfFixture,
  sha256HexOf
} from '../../../test/fixtures/pdf-annotation-fixtures'
import { PdfAnnotationRepository } from './pdf-annotation-repository'
import { PdfAnnotationService } from './pdf-annotation-service'

// The window-facing annotation surface, over the real A1 store and the real A2 import channel.
//
// What this suite is about is the three things the renderer must never be allowed to decide for itself:
// which bytes an annotation belongs to (the version authority resolves the checksum), what an anchor
// says now (every annotation comes back labelled, including the ones that belong to another version),
// and what an import actually did (A2's own report, or a named refusal).

const ANCHOR: PdfAnnotationAnchorRequest = {
  projectId: 'project-1',
  sessionId: 'session-1',
  artifactId: 'artifact-1',
  versionId: 'version-1'
}

const CHECKSUM = 'A'.repeat(64)
const NEXT_CHECKSUM = 'b'.repeat(64)

const selector = {
  version: 1 as const,
  shape: 'area' as const,
  page: 1,
  rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 }
}

let root: string
let store: InMemoryPdfAnnotationStore
let repository: PdfAnnotationRepository

type ResolvedVersions = Record<string, string>

const createService = (
  versions: ResolvedVersions = { 'version-1': CHECKSUM },
  filePath?: string
): PdfAnnotationService =>
  new PdfAnnotationService({
    repository,
    resolveVersion: async (request) => {
      const checksum = versions[request.versionId]
      return checksum ? { versionId: request.versionId, checksum } : undefined
    },
    resolveVersionFile: async () => {
      if (!filePath) throw new Error('no file was staged for this import')
      return filePath
    }
  })

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pdf-annotation-service-'))
  store = createInMemoryPdfAnnotationStore()
  repository = new PdfAnnotationRepository(() => Promise.resolve(store.client))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const stage = async (name: string, bytes: Uint8Array): Promise<string> => {
  const filePath = join(root, name)
  await writeFile(filePath, bytes)
  return filePath
}

describe('PdfAnnotationService', () => {
  it('anchors a created annotation to the version the authority resolved, checksum and all', async () => {
    const service = createService()

    const created = await service.create({ ...ANCHOR, kind: 'area', selector, body: 'figure 2' })

    expect(created).toMatchObject({
      sourceFileId: 'artifact-1',
      versionId: 'version-1',
      // The renderer never sends a checksum; the store gets the one the version authority reported,
      // normalized to lowercase because that is how every other checksum in the app is written.
      checksum: CHECKSUM.toLowerCase(),
      kind: 'area',
      body: 'figure 2'
    })
    expect(store.annotations).toHaveLength(1)
  })

  it('refuses a kind and selector that disagree, naming the pair, and stores nothing', async () => {
    const service = createService()

    await expect(
      service.create({
        ...ANCHOR,
        kind: 'highlight',
        selector,
        body: ''
      })
    ).rejects.toThrow(/kind "highlight" needs selector shape "text-range"/)
    expect(store.annotations).toHaveLength(0)
  })

  it('refuses a version the store does not know instead of writing against the ids alone', async () => {
    const service = createService({})

    await expect(service.create({ ...ANCHOR, kind: 'area', selector })).rejects.toThrow(
      /Version version-1 of artifact artifact-1 is not one this store knows/
    )
    await expect(service.list(ANCHOR)).rejects.toThrow(
      /is not one this store knows, so no annotation was stored or read against it/
    )
    expect(store.annotations).toHaveLength(0)
  })

  // The red line of the whole slice: markup drawn on other bytes is REPORTED, never dropped and never
  // re-pointed. Both mismatching states are named here, from one read.
  it('labels every annotation by its anchor state, including the ones on another version', async () => {
    const service = createService({ 'version-1': CHECKSUM, 'version-2': NEXT_CHECKSUM })
    const onVersionTwo = await service.create({
      ...ANCHOR,
      versionId: 'version-2',
      kind: 'area',
      selector,
      body: 'drawn on the newer bytes'
    })
    const onVersionOne = await service.create({
      ...ANCHOR,
      kind: 'area',
      selector,
      body: 'drawn on the bytes on screen'
    })

    const result = await service.list(ANCHOR)

    expect(result.anchor).toEqual({
      sourceFileId: 'artifact-1',
      versionId: 'version-1',
      checksum: CHECKSUM.toLowerCase()
    })
    expect(result.counts).toEqual({ current: 1, versionChanged: 1, checksumMismatch: 0 })
    // Both of them come back, oldest first, each carrying its own state — the annotation on the newer
    // version is not filtered out and not re-pointed.
    expect(
      result.annotations.map(({ annotation, anchorState }) => [annotation.id, anchorState])
    ).toEqual([
      [onVersionTwo.id, 'version-changed'],
      [onVersionOne.id, 'current']
    ])
  })

  it('names a broken anchor when the same version id now carries different bytes', async () => {
    const service = createService()
    await service.create({ ...ANCHOR, kind: 'area', selector })

    // The version id stayed, its bytes did not: this is the state an anchor cannot survive, and it is
    // reported rather than resolved by trusting the id.
    const afterRewrite = createService({ 'version-1': NEXT_CHECKSUM })
    const result = await afterRewrite.list(ANCHOR)

    expect(result.counts).toEqual({ current: 0, versionChanged: 0, checksumMismatch: 1 })
    expect(result.annotations[0]?.anchorState).toBe('checksum-mismatch')
  })

  it('re-anchors one annotation onto the version on screen and leaves the original where it was', async () => {
    const service = createService({ 'version-1': CHECKSUM, 'version-2': NEXT_CHECKSUM })
    const source = await service.create({
      ...ANCHOR,
      versionId: 'version-2',
      kind: 'area',
      selector,
      body: 'keep this region'
    })

    const result = await service.reattach({ ...ANCHOR, annotationId: source.id })

    expect(result.source).toEqual(source)
    expect(result.annotation).toMatchObject({
      sourceFileId: 'artifact-1',
      versionId: 'version-1',
      checksum: CHECKSUM.toLowerCase(),
      kind: 'area',
      body: 'keep this region',
      selector
    })
    // Two annotations now: the copy on the version on screen, and the untouched original.
    expect(store.annotations).toHaveLength(2)
    expect(
      await repository.listAnnotations({ sourceFileId: 'artifact-1', versionId: 'version-2' })
    ).toHaveLength(1)
  })

  it('refuses a re-anchor that would duplicate the annotation on its own version', async () => {
    const service = createService()
    const created = await service.create({ ...ANCHOR, kind: 'area', selector })

    await expect(service.reattach({ ...ANCHOR, annotationId: created.id })).rejects.toThrow(
      /already anchored to this file version/
    )
    expect(store.annotations).toHaveLength(1)
  })

  it('refuses a re-anchor that names an annotation belonging to another file', async () => {
    const service = createService({ 'version-1': CHECKSUM })
    const created = await service.create({ ...ANCHOR, kind: 'area', selector })

    await expect(
      service.reattach({
        ...ANCHOR,
        artifactId: 'artifact-other',
        annotationId: created.id
      })
    ).rejects.toThrow(
      /belongs to file artifact-1 and cannot be re-anchored onto file artifact-other/
    )
    expect(store.annotations).toHaveLength(1)
  })

  it('removes one annotation and reports whether it existed', async () => {
    const service = createService()
    const created = await service.create({ ...ANCHOR, kind: 'area', selector })

    expect(await service.remove({ annotationId: created.id })).toEqual({ removed: true })
    expect(await service.remove({ annotationId: created.id })).toEqual({ removed: false })
    await expect(service.remove({ annotationId: '  ' })).rejects.toThrow(/needs the annotation id/)
  })

  it('passes the import report through unchanged, including what the file carried and was skipped', async () => {
    const bytes = annotatedPdfFixture()
    const filePath = await stage('annotated.pdf', bytes)
    const service = createService({ 'version-1': sha256HexOf(bytes) }, filePath)

    const outcome = await service.import(ANCHOR)

    expect(outcome.status).toBe('report')
    if (outcome.status !== 'report') throw new Error('expected a report')
    expect(outcome.report.status).toBe('imported')
    expect(outcome.report.imported).toBeGreaterThan(0)
    // The report is A2's: the counts per kind and the skipped subtypes are what the file actually holds.
    expect(outcome.report.annotationsInFile).toBe(
      outcome.report.imported + outcome.report.skipped.reduce((sum, skip) => sum + skip.count, 0)
    )
    expect(
      await repository.countAnnotations({ sourceFileId: 'artifact-1', versionId: 'version-1' })
    ).toBe(outcome.report.imported)
  })

  it('answers "no annotations" for a file that carries none, rather than a success with zero rows', async () => {
    const bytes = plainPdfFixture()
    const filePath = await stage('plain.pdf', bytes)
    const service = createService({ 'version-1': sha256HexOf(bytes) }, filePath)

    const outcome = await service.import(ANCHOR)

    expect(outcome).toMatchObject({
      status: 'report',
      report: { status: 'no-annotations', imported: 0, receiptCreated: false }
    })
    expect(store.imports).toHaveLength(0)
  })

  it('names the failure when the bytes are not the version that was named', async () => {
    const filePath = await stage('annotated.pdf', annotatedPdfFixture())
    // The version authority reports a checksum the bytes on disk do not hash to — the one case where an
    // import must not run at all.
    const service = createService({ 'version-1': 'c'.repeat(64) }, filePath)

    const outcome = await service.import(ANCHOR)

    expect(outcome.status).toBe('failure')
    if (outcome.status !== 'failure') throw new Error('expected a failure')
    expect(outcome.code).toBe('checksum-mismatch')
    expect(store.annotations).toHaveLength(0)
    expect(store.imports).toHaveLength(0)
  })

  it('names the failure when the file is not a PDF at all', async () => {
    const bytes = new TextEncoder().encode('this is not a PDF')
    const filePath = await stage('notes.txt', bytes)
    const service = createService({ 'version-1': sha256HexOf(bytes) }, filePath)

    const outcome = await service.import(ANCHOR)

    expect(outcome.status).toBe('failure')
    if (outcome.status !== 'failure') throw new Error('expected a failure')
    expect(outcome.code).toBe('unreadable-pdf')
    expect(store.annotations).toHaveLength(0)
  })
})
