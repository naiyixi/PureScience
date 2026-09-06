import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createProjectDbClient, ensureProjectSchema } from '../projects/prisma-client'
import { VisionEvidenceRepository } from './vision-evidence-repository'

const sha256 = async (value: string): Promise<string> => {
  const { createHash } = await import('node:crypto')
  return createHash('sha256').update(value).digest('hex')
}

describe('VisionEvidenceRepository (SQLite-backed)', () => {
  let storageRoot: string
  let client: Awaited<ReturnType<typeof createProjectDbClient>>
  let repository: VisionEvidenceRepository

  beforeEach(async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'vision-evidence-'))
    client = createProjectDbClient(storageRoot)
    await ensureProjectSchema(client)
    repository = new VisionEvidenceRepository(async () => client)
  })

  afterEach(async () => {
    await client.$disconnect()
    await rm(storageRoot, { recursive: true, force: true })
  })

  const makeInput = async (
    overrides: Record<string, string | number> = {}
  ): Promise<ReturnType<typeof makeInputInner>> => makeInputInner(overrides)

  async function makeInputInner(overrides: Record<string, string | number> = {}): Promise<{
    identityKey: string
    imageChecksum: string
    extractorFingerprint: string
    evidenceSchemaVersion: number
    evidenceJson: string
    projectId: string
    sessionId: string
    source: { kind: 'message-image'; messageId: string; imageId: string }
    mimeType: string
  }> {
    const imageChecksum = (overrides.imageChecksum as string) ?? (await sha256('image-bytes'))
    const extractorFingerprint =
      (overrides.extractorFingerprint as string) ?? (await sha256('extractor-v1'))
    const evidenceSchemaVersion = (overrides.evidenceSchemaVersion as number) ?? 1
    const evidenceJson =
      (overrides.evidenceJson as string) ?? JSON.stringify({ caption: 'a chart' })
    const identityKey = await sha256(
      [imageChecksum, extractorFingerprint, String(evidenceSchemaVersion)].join('|')
    )
    return {
      identityKey,
      imageChecksum,
      extractorFingerprint,
      evidenceSchemaVersion,
      evidenceJson,
      projectId: 'project-1',
      sessionId: 'session-1',
      source: { kind: 'message-image' as const, messageId: 'msg-1', imageId: 'img-1' },
      mimeType: 'image/png'
    }
  }

  it('saves and finds evidence round-trip', async () => {
    const input = await makeInput()
    await repository.save(input)
    const found = await repository.find({
      identityKey: input.identityKey,
      imageChecksum: input.imageChecksum,
      extractorFingerprint: input.extractorFingerprint,
      evidenceSchemaVersion: input.evidenceSchemaVersion
    })
    expect(found).toBe(input.evidenceJson)
  })

  it('returns undefined on a fresh identityKey (cache miss)', async () => {
    const input = await makeInput()
    const found = await repository.find({
      identityKey: input.identityKey,
      imageChecksum: input.imageChecksum,
      extractorFingerprint: input.extractorFingerprint,
      evidenceSchemaVersion: input.evidenceSchemaVersion
    })
    expect(found).toBeUndefined()
  })

  it('degrades to a miss when the image checksum changes', async () => {
    const input = await makeInput()
    await repository.save(input)
    const found = await repository.find({
      identityKey: input.identityKey,
      imageChecksum: await sha256('different-bytes'),
      extractorFingerprint: input.extractorFingerprint,
      evidenceSchemaVersion: input.evidenceSchemaVersion
    })
    expect(found).toBeUndefined()
  })

  it('degrades to a miss when the extractor fingerprint changes', async () => {
    const input = await makeInput()
    await repository.save(input)
    const found = await repository.find({
      identityKey: input.identityKey,
      imageChecksum: input.imageChecksum,
      extractorFingerprint: await sha256('extractor-v2'),
      evidenceSchemaVersion: input.evidenceSchemaVersion
    })
    expect(found).toBeUndefined()
  })

  it('degrades to a miss when the evidence schema version changes', async () => {
    const input = await makeInput()
    await repository.save(input)
    const found = await repository.find({
      identityKey: input.identityKey,
      imageChecksum: input.imageChecksum,
      extractorFingerprint: input.extractorFingerprint,
      evidenceSchemaVersion: input.evidenceSchemaVersion + 1
    })
    expect(found).toBeUndefined()
  })

  it('degrades to a miss when the stored evidence JSON was tampered with', async () => {
    const input = await makeInput()
    await repository.save(input)
    // Tamper directly in the DB: flip the evidenceJson so its checksum no longer matches.
    await client.$executeRawUnsafe(
      `UPDATE "VisionEvidence" SET "evidenceJson" = '{"caption":"tampered"}' WHERE "id" = ?`,
      input.identityKey
    )
    const found = await repository.find({
      identityKey: input.identityKey,
      imageChecksum: input.imageChecksum,
      extractorFingerprint: input.extractorFingerprint,
      evidenceSchemaVersion: input.evidenceSchemaVersion
    })
    expect(found).toBeUndefined()
  })

  it('upserts in place for the same identityKey', async () => {
    const input = await makeInput()
    await repository.save(input)
    await repository.save({
      ...input,
      sessionId: 'session-2',
      evidenceJson: JSON.stringify({ caption: 'updated' })
    })
    const found = await repository.find({
      identityKey: input.identityKey,
      imageChecksum: input.imageChecksum,
      extractorFingerprint: input.extractorFingerprint,
      evidenceSchemaVersion: input.evidenceSchemaVersion
    })
    expect(found).toBe(JSON.stringify({ caption: 'updated' }))
    // Only one row for the identity.
    const rows = await client.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT "id" FROM "VisionEvidence" WHERE "id" = ?`,
      input.identityKey
    )
    expect(rows).toHaveLength(1)
  })

  it('persists the upload-version source shape', async () => {
    const input = await makeInput()
    await repository.save({
      ...input,
      source: { kind: 'upload-version', uploadVersionId: 'upload-1' }
    })
    const rows = await client.$queryRawUnsafe<Array<{ sourceKind: string }>>(
      `SELECT "sourceKind" FROM "VisionEvidence" WHERE "id" = ?`,
      input.identityKey
    )
    expect(rows[0]?.sourceKind).toBe('upload-version')
  })

  it('deleteSessions removes only the named sessions', async () => {
    const first = await makeInput({ sessionId: 'session-1' } as never)
    const second = await makeInput({ sessionId: 'session-2' } as never)
    await repository.save({ ...first, sessionId: 'session-1' })
    await repository.save({ ...second, sessionId: 'session-2' })
    await repository.deleteSessions(['session-1'])
    const remaining = await client.$queryRawUnsafe<Array<{ sessionId: string }>>(
      `SELECT "sessionId" FROM "VisionEvidence"`
    )
    expect(remaining.map((row) => row.sessionId)).toEqual(['session-2'])
  })

  it('reconcileSessions removes rows for vanished sessions', async () => {
    const first = await makeInput({ sessionId: 'session-1' } as never)
    await repository.save({ ...first, sessionId: 'session-1' })
    await repository.reconcileSessions(['session-other'])
    const remaining = await client.$queryRawUnsafe<Array<{ sessionId: string }>>(
      `SELECT "sessionId" FROM "VisionEvidence"`
    )
    expect(remaining).toHaveLength(0)
  })
})
