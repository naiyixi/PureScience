// RO-Crate 1.1 export writer (main process).
//
// The exporter is deliberately filesystem-driven: the app's durable provenance layout under
// `<dataRoot>/artifacts/<projectId>/<appSessionId>/.provenance/<artifactId>/versions/<versionId>/`
// already holds, for every published Artifact Version, the canonical `evidence.json` record and the
// immutable `content` bytes. That is exactly the "file version + hash + how it was made" semantic an
// RO-Crate needs, so the crate is built from those records rather than from a new inventory — a
// Version that is still in `.staging` (never published) is not in that layout and is therefore never
// exported, and a Version whose bytes no longer match its recorded checksum is refused rather than
// copied. No unprovenanced file can enter a crate.
//
// The pure builder and the compliance assertions live in `src/shared/ro-crate.ts`; this module only
// does bytes, and it re-validates the document it just wrote before reporting success.

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { ARTIFACTS_DIR, SAFE_SEGMENT_PATTERN } from '../artifacts/storage-layout'
import type { ArtifactVersionEvidence } from '../../shared/artifact-provenance'
import {
  RO_CRATE_CONTENT_DIRECTORY,
  RO_CRATE_METADATA_FILENAME,
  allocateRoCrateContentPath,
  buildRoCrateMetadata,
  failedRoCrateAssertions,
  roCrateContentEntityFromArtifactVersion,
  validateRoCrate,
  type RoCrateContentEntity,
  type RoCrateCreator,
  type RoCrateMetadataDocument,
  type RoCratePayloadDigest,
  type RoCrateValidationReport
} from '../../shared/ro-crate'
import { sha256Hex } from './digest'

// Same segment name the Artifact Provenance repository writes its published Versions into.
const PROVENANCE_DIR = '.provenance'
const VERSIONS_DIR = 'versions'
const CONTENT_FILENAME = 'content'
const EVIDENCE_FILENAME = 'evidence.json'

const SHA256_HEX = /^[a-f0-9]{64}$/

const isEnoent = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  (error as { code?: unknown }).code === 'ENOENT'

const readDirSafe = async (path: string): Promise<string[]> => {
  const entries = await readdir(path, { withFileTypes: true }).catch((error: unknown) => {
    if (isEnoent(error)) return []
    throw error
  })
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
}

export type RoCrateProjectVersion = {
  projectId: string
  appSessionId: string
  artifactId: string
  versionId: string
  evidence: ArtifactVersionEvidence
  /** Absolute path of the immutable published bytes on disk. */
  contentPath: string
}

export type RoCrateVersionSkipReason =
  'evidence-unreadable' | 'evidence-invalid' | 'content-missing' | 'checksum-mismatch'

export type RoCrateSkippedVersion = {
  projectId: string
  appSessionId: string
  artifactId: string
  versionId: string
  reason: RoCrateVersionSkipReason
}

const isEvidenceShape = (value: unknown): value is ArtifactVersionEvidence => {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    record.schema_version === 1 &&
    typeof record.project_id === 'string' &&
    typeof record.app_session_id === 'string' &&
    typeof record.artifact_id === 'string' &&
    typeof record.version_id === 'string' &&
    typeof record.version_number === 'number' &&
    typeof record.filename === 'string' &&
    record.filename.length > 0 &&
    typeof record.size_bytes === 'number' &&
    typeof record.checksum === 'string' &&
    SHA256_HEX.test(record.checksum) &&
    typeof record.created_at === 'string' &&
    Array.isArray(record.inputs) &&
    typeof record.producer === 'object' &&
    record.producer !== null
  )
}

/**
 * Every PUBLISHED Artifact Version of one Project, read from the durable provenance layout. Each
 * returned record's bytes were re-hashed and matched against the version's own recorded checksum;
 * anything that failed that check is returned in `skipped` and is never exported.
 */
export const readRoCrateProjectVersions = async (input: {
  storageRoot: string
  projectId: string
}): Promise<{ versions: RoCrateProjectVersion[]; skipped: RoCrateSkippedVersion[] }> => {
  const { storageRoot, projectId } = input
  if (!SAFE_SEGMENT_PATTERN.test(projectId)) {
    throw new Error(`Unsafe project id for RO-Crate export: ${projectId}`)
  }

  const versions: RoCrateProjectVersion[] = []
  const skipped: RoCrateSkippedVersion[] = []
  const artifactRoot = join(storageRoot, ARTIFACTS_DIR, projectId)

  const sessionIds = (await readDirSafe(artifactRoot)).filter((name) =>
    SAFE_SEGMENT_PATTERN.test(name)
  )

  for (const appSessionId of sessionIds) {
    const provenanceRoot = join(artifactRoot, appSessionId, PROVENANCE_DIR)
    const artifactIds = (await readDirSafe(provenanceRoot)).filter(
      (name) => name !== '.staging' && name !== '.quarantine' && SAFE_SEGMENT_PATTERN.test(name)
    )

    for (const artifactId of artifactIds) {
      const versionsRoot = join(provenanceRoot, artifactId, VERSIONS_DIR)
      const versionIds = (await readDirSafe(versionsRoot)).filter((name) =>
        SAFE_SEGMENT_PATTERN.test(name)
      )

      for (const versionId of versionIds) {
        const versionDirectory = join(versionsRoot, versionId)
        const skip = (reason: RoCrateVersionSkipReason): void => {
          skipped.push({ projectId, appSessionId, artifactId, versionId, reason })
        }

        let evidence: ArtifactVersionEvidence
        try {
          const raw = await readFile(join(versionDirectory, EVIDENCE_FILENAME), 'utf8')
          const parsed: unknown = JSON.parse(raw)
          if (!isEvidenceShape(parsed)) {
            skip('evidence-invalid')
            continue
          }
          if (
            parsed.project_id !== projectId ||
            parsed.app_session_id !== appSessionId ||
            parsed.artifact_id !== artifactId ||
            parsed.version_id !== versionId
          ) {
            // A record that disagrees with its own directory is not evidence of anything.
            skip('evidence-invalid')
            continue
          }
          evidence = parsed
        } catch (error) {
          skip(isEnoent(error) ? 'content-missing' : 'evidence-unreadable')
          continue
        }

        const contentPath = join(versionDirectory, CONTENT_FILENAME)
        let bytes: Buffer
        try {
          bytes = await readFile(contentPath)
        } catch (error) {
          skip(isEnoent(error) ? 'content-missing' : 'evidence-unreadable')
          continue
        }
        if (bytes.byteLength !== evidence.size_bytes || sha256Hex(bytes) !== evidence.checksum) {
          // The app's own rule for this Version: content that does not hash to the recorded checksum
          // is corrupt. Such a copy must not be exported as if it were the Version.
          skip('checksum-mismatch')
          continue
        }

        versions.push({ projectId, appSessionId, artifactId, versionId, evidence, contentPath })
      }
    }
  }

  versions.sort((left, right) =>
    `${left.evidence.created_at}:${left.versionId}`.localeCompare(
      `${right.evidence.created_at}:${right.versionId}`
    )
  )
  return { versions, skipped }
}

export type RoCrateExportedFile = {
  cratePath: string
  appSessionId: string
  artifactId: string
  versionId: string
  sizeBytes: number
  sha256: string
}

export type RoCrateExportResult = {
  outputDir: string
  metadataPath: string
  metadata: RoCrateMetadataDocument
  files: RoCrateExportedFile[]
  validation: RoCrateValidationReport
  skipped: RoCrateSkippedVersion[]
}

export class RoCrateExportError extends Error {}

export type RoCrateExportInput = {
  storageRoot: string
  outputDir: string
  projectId: string
  /** Human-facing project title. Falls back to the opaque project id. */
  projectName?: string
  description?: string
  app: { name: string; version: string; url: string }
  publisher?: RoCrateCreator
  creators?: readonly RoCrateCreator[]
  license?: { id: string; name: string }
  /** ISO 8601; defaults to now. */
  generatedAt?: string
}

/**
 * Writes one Project as an RO-Crate 1.1 research object: `ro-crate-metadata.json` plus byte-identical
 * copies of every published Version under `files/`. Refuses (throws) when the Project has no
 * exportable Version, and refuses again if the document it just wrote does not pass every assertion —
 * a crate that does not validate is not a deliverable.
 */
export const writeRoCrateExport = async (
  input: RoCrateExportInput
): Promise<RoCrateExportResult> => {
  const { versions, skipped } = await readRoCrateProjectVersions({
    storageRoot: input.storageRoot,
    projectId: input.projectId
  })
  if (versions.length === 0) {
    throw new RoCrateExportError(
      `Project ${input.projectId} has no published Artifact Version to export.`
    )
  }

  const takenPaths = new Set<string>([RO_CRATE_METADATA_FILENAME])
  const planned: { entity: RoCrateContentEntity; version: RoCrateProjectVersion }[] = []
  for (const version of versions) {
    const cratePath = allocateRoCrateContentPath(version.evidence.filename, takenPaths)
    takenPaths.add(cratePath)
    planned.push({
      entity: roCrateContentEntityFromArtifactVersion({
        evidence: version.evidence,
        cratePath
      }),
      version
    })
  }
  const entities = planned.map((entry) => entry.entity)

  const sessions = [...new Set(versions.map((version) => version.appSessionId))].sort()
  const generatedAt = input.generatedAt ?? new Date().toISOString()

  const metadata = buildRoCrateMetadata({
    projectId: input.projectId,
    ...(input.projectName ? { projectName: input.projectName } : {}),
    name: input.projectName
      ? `${input.projectName} — research object`
      : `research object ${input.projectId}`,
    description:
      input.description ??
      `Files produced in the ${input.app.name} workbench for project ${
        input.projectName ?? input.projectId
      }, exported with the immutable Artifact Version each file came from.`,
    datePublished: generatedAt,
    app: input.app,
    ...(input.publisher ? { publisher: input.publisher } : {}),
    ...(input.creators && input.creators.length > 0 ? { creators: input.creators } : {}),
    ...(input.license ? { license: input.license } : {}),
    sessions: sessions.map((id) => ({ id })),
    entities
  })

  await mkdir(input.outputDir, { recursive: true })

  const payloadDigests = new Map<string, RoCratePayloadDigest>()
  const files: RoCrateExportedFile[] = []
  for (const { entity, version } of planned) {
    const targetPath = join(input.outputDir, entity.cratePath)
    await mkdir(join(input.outputDir, RO_CRATE_CONTENT_DIRECTORY), { recursive: true })
    await writeFile(targetPath, await readFile(version.contentPath))
    // Hash what actually landed on disk; the record's own checksum is never trusted as a substitute.
    const written = await readFile(targetPath)
    payloadDigests.set(entity.cratePath, {
      sizeBytes: written.byteLength,
      sha256: sha256Hex(written)
    })
    files.push({
      cratePath: entity.cratePath,
      appSessionId: version.appSessionId,
      artifactId: version.artifactId,
      versionId: version.versionId,
      sizeBytes: written.byteLength,
      sha256: sha256Hex(written)
    })
  }

  const metadataPath = join(input.outputDir, RO_CRATE_METADATA_FILENAME)
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`)

  const validation = validateRoCrate({
    document: metadata,
    payloadPaths: files.map((file) => file.cratePath),
    payloadDigests
  })
  if (!validation.ok) {
    const failed = failedRoCrateAssertions(validation)
      .map((assertion) => `${assertion.id} (${assertion.level}): ${assertion.detail ?? 'failed'}`)
      .join('; ')
    throw new RoCrateExportError(`RO-Crate validation failed: ${failed}`)
  }

  return { outputDir: input.outputDir, metadataPath, metadata, files, validation, skipped }
}
