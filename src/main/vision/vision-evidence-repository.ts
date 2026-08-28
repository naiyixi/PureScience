import { createHash } from 'node:crypto'

import type { PrismaClient } from '@prisma/client'

// Vision-evidence persistence for the image relay (source port).
//
// When the active agent backend is text-only (no image input), image attachments are analyzed by a
// dedicated Vision model in an isolated session. The extracted evidence JSON is cached here so
// replaying an image-bearing conversation after a restart does not re-pay for the same canonical
// image analysis. Cache correctness is guarded by four independent fingerprints:
//   - identityKey (primary key): sha256 of the canonical image bytes + extractor fingerprint +
//     evidence schema version, i.e. the "same image, same extractor, same schema" identity.
//   - imageChecksum: sha256 of the canonical image bytes (re-verified on every hit).
//   - extractorFingerprint: sha256 of the extractor implementation/config (invalidates old logic).
//   - evidenceChecksum: sha256 of the stored evidenceJson (tamper/consistency guard).

type VisionEvidenceSource =
  | Readonly<{ kind: 'upload-version'; uploadVersionId: string }>
  | Readonly<{ kind: 'message-image'; messageId: string; imageId: string }>

type FindVisionEvidenceInput = Readonly<{
  identityKey: string
  imageChecksum: string
  extractorFingerprint: string
  evidenceSchemaVersion: number
}>

type SaveVisionEvidenceInput = FindVisionEvidenceInput &
  Readonly<{
    projectId: string
    sessionId: string
    source: VisionEvidenceSource
    mimeType: string
    evidenceJson: string
  }>

type VisionEvidencePersistence = Readonly<{
  find(input: FindVisionEvidenceInput): Promise<string | undefined>
  save(input: SaveVisionEvidenceInput): Promise<void>
}>

// Only the vision-evidence delegate is needed; typing to this subset keeps the repository
// unit-testable with a lightweight mock instead of a real (engine-backed) PrismaClient.
type VisionEvidenceClient = Pick<PrismaClient, 'visionEvidence'>
// Resolves the Prisma client on demand so a failed initialization is not held forever.
type VisionEvidenceClientProvider = () => Promise<VisionEvidenceClient>

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

class VisionEvidenceRepository implements VisionEvidencePersistence {
  constructor(private readonly getClient: VisionEvidenceClientProvider) {}

  // Returns cached evidence JSON only when every fingerprint still matches the request. A mismatch
  // (image changed, extractor upgraded, evidence corrupted) degrades to a cache miss so the caller
  // re-runs the Vision analysis instead of trusting stale data.
  async find(input: FindVisionEvidenceInput): Promise<string | undefined> {
    const client = await this.getClient()
    const row = await client.visionEvidence.findUnique({ where: { id: input.identityKey } })
    if (
      !row ||
      row.imageChecksum !== input.imageChecksum ||
      row.extractorFingerprint !== input.extractorFingerprint ||
      row.evidenceSchemaVersion !== input.evidenceSchemaVersion ||
      row.evidenceChecksum !== sha256(row.evidenceJson)
    ) {
      return undefined
    }
    return row.evidenceJson
  }

  // Upserts cached evidence. The identityKey is the same-image/same-extractor/same-schema identity,
  // so re-analysis of the same image refreshes the row in place.
  async save(input: SaveVisionEvidenceInput): Promise<void> {
    const client = await this.getClient()
    const sourceFields =
      input.source.kind === 'upload-version'
        ? {
            sourceKind: input.source.kind,
            uploadVersionId: input.source.uploadVersionId,
            sourceMessageId: null,
            sourceImageId: null
          }
        : {
            sourceKind: input.source.kind,
            uploadVersionId: null,
            sourceMessageId: input.source.messageId,
            sourceImageId: input.source.imageId
          }
    const data = {
      projectId: input.projectId,
      sessionId: input.sessionId,
      ...sourceFields,
      imageChecksum: input.imageChecksum,
      mimeType: input.mimeType,
      extractorFingerprint: input.extractorFingerprint,
      evidenceSchemaVersion: input.evidenceSchemaVersion,
      evidenceJson: input.evidenceJson,
      evidenceChecksum: sha256(input.evidenceJson)
    }
    await client.visionEvidence.upsert({
      where: { id: input.identityKey },
      create: { id: input.identityKey, ...data },
      update: data
    })
  }

  // Deletes evidence rows for removed sessions (called when sessions are deleted so the cache does
  // not outlive the conversation that produced it).
  async deleteSessions(sessionIds: readonly string[]): Promise<void> {
    if (sessionIds.length === 0) return
    const client = await this.getClient()
    await client.visionEvidence.deleteMany({ where: { sessionId: { in: [...sessionIds] } } })
  }

  // Deletes evidence rows whose session no longer exists (cache sweep).
  async reconcileSessions(existingSessionIds: readonly string[]): Promise<void> {
    const client = await this.getClient()
    await client.visionEvidence.deleteMany({
      where: { sessionId: { notIn: [...existingSessionIds] } }
    })
  }
}

export { VisionEvidenceRepository }
export type {
  FindVisionEvidenceInput,
  SaveVisionEvidenceInput,
  VisionEvidenceClient,
  VisionEvidenceClientProvider,
  VisionEvidencePersistence,
  VisionEvidenceSource
}
