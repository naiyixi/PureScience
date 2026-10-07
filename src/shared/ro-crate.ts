// RO-Crate 1.1 export: the interoperable research-object view of one Project's produced files.
//
// Why this module is pure: an RO-Crate is only worth exporting if a FOREIGN tool can read it, so the
// shape of `ro-crate-metadata.json` and the rules that make it a valid RO-Crate live here, in one
// place, with no database, no window and no filesystem. The main-process writer
// (`src/main/ro-crate/export.ts`) does the byte work and then re-runs THESE assertions before it
// reports success — so "the crate validates" is never a claim produced by a different code path
// than the one the tests exercise.
//
// Traceability contract: every File entity in a crate is a byte-identical copy of a file the app
// itself already stores under an immutable, checksummed Version (an Artifact Version or a Project
// File). A content record that carries no recorded sha256 is refused rather than exported: an
// untraceable copy inside a crate is worse than a missing one.
//
// Spec notes that shaped the output (RO-Crate 1.1):
//   * the Metadata File Descriptor MUST be `{"@id": "ro-crate-metadata.json", "@type": "CreativeWork"}`
//     with `about` -> the Root Data Entity and `conformsTo` -> a `https://w3id.org/ro/crate/` permalink;
//   * the Root Data Entity MUST be a `Dataset` whose `@id` ends with `/`;
//   * File entities MUST be `File` and MUST be linked from the Root Data Entity through `hasPart`;
//   * `@graph` MUST NOT contain two entities with the same `@id`;
//   * software that created a file SHOULD be a `SoftwareApplication` with a `version`, associated
//     with the file through a `CreateAction` (`instrument` + `result`).
// `sha256` is NOT a term of the RO-Crate 1.1 JSON-LD context (RO-Crate 1.2/1.3 added it, mapped to
// http://schema.org/sha256). A 1.1 crate that wants to carry a checksum therefore has to declare the
// term; we declare exactly the IRI the later spec versions adopted, in a local context AFTER the
// 1.1 context, so the 1.1 context is still referenced and a 1.2+ reader resolves the property identically.

import { createArtifactVersionLocator, type ArtifactVersionEvidence } from './artifact-provenance'
import type { ProjectFileItem } from './project-files'

export const RO_CRATE_CONTEXT_URL = 'https://w3id.org/ro/crate/1.1/context'
/** Versioned permalink of the profile this module writes. */
export const RO_CRATE_PROFILE_URL = 'https://w3id.org/ro/crate/1.1'
/** The RO-Crate Metadata File, by spec the only file whose name is fixed. */
export const RO_CRATE_METADATA_FILENAME = 'ro-crate-metadata.json'
export const RO_CRATE_ROOT_DATASET_ID = './'
/** Payload directory inside the crate. Keeps app files from colliding with the metadata file. */
export const RO_CRATE_CONTENT_DIRECTORY = 'files'
/** The IRI RO-Crate 1.2+ maps `sha256` to; declared locally because the 1.1 context has no such term. */
export const RO_CRATE_SHA256_TERM_IRI = 'http://schema.org/sha256'

export type RoCrateJsonLdReference = { '@id': string }

export type RoCrateJsonLdEntity = {
  '@id': string
  '@type': string | string[]
  [property: string]: unknown
}

export type RoCrateMetadataDocument = {
  /** `[<RO-Crate 1.1 context>, <local term declarations>]`. */
  '@context': (string | Record<string, string>)[]
  '@graph': RoCrateJsonLdEntity[]
}

/** Where a content file came from inside the app. Never invented: copied from a stored record. */
export type RoCrateFileProvenance = {
  /** Which app-side store the bytes live in. */
  sourceKind: 'artifact-version' | 'project-file'
  projectId: string
  appSessionId: string
  /** Artifact lineage id; absent for uploads mirrored as Project Files. */
  artifactId?: string
  /** Immutable Version id whose checksum the crate repeats. */
  versionId?: string
  versionNumber?: number
  sourceFileId?: string
  sourceVersionId?: string
  /** The app's own recorded sha256 of the bytes. Required — an unhashed file is not exportable. */
  recordedSha256: string
  /** The app's own recorded byte length. */
  recordedSizeBytes: number
  createdAt?: string
  agentName?: string
  producerRunId?: string
  kernelKind?: string
  reproductionCode?: string
  environment?: {
    name: string
    runtimeVersion?: string
    manifestChecksum?: string
  }
  /** Inputs the recorded run consumed, as the app recorded them. */
  inputs?: readonly RoCrateInputRecord[]
}

export type RoCrateInputRecord = {
  ordinal: number
  kind: 'artifact-version' | 'upload-version'
  /** Repo identity of the input Version, used to recognise an input that is itself in the crate. */
  versionKey: string
  filename: string
  sizeBytes: number
  sha256: string
  contentType?: string
}

export type RoCrateContentEntity = {
  /** Crate-relative payload path. This IS the entity `@id`, so id and bytes cannot drift apart. */
  cratePath: string
  name: string
  contentType?: string
  sizeBytes: number
  sha256: string
  provenance: RoCrateFileProvenance
}

export type RoCrateCreator = {
  type: 'Person' | 'Organization'
  id: string
  name: string
  url?: string
}

export type RoCrateBuildInput = {
  projectId: string
  projectName?: string
  /** Title of the research object. */
  name: string
  description: string
  /** ISO 8601; written to the Root Data Entity's `datePublished`. */
  datePublished: string
  license?: { id: string; name: string }
  app: { name: string; version: string; url: string }
  publisher?: RoCrateCreator
  creators?: readonly RoCrateCreator[]
  /** Every analysis session whose recorded runs produced files in this crate. */
  sessions?: readonly { id: string; title?: string }[]
  entities: readonly RoCrateContentEntity[]
}

// ---------------------------------------------------------------------------------------------
// Path / id helpers
// ---------------------------------------------------------------------------------------------

// Crate-relative ids must be literal paths so `@id` and the file on disk are the same string. That
// rules out characters that JSON-LD would require URI-encoding (spaces, CJK, `%`, `#`, `?`), so a
// name is NORMALISED for the path and its original spelling is kept in `name`.
const UNSAFE_PATH_CHARS = /[^A-Za-z0-9._-]+/g

export const roCratePathSafeName = (name: string): string => {
  const cleaned = name
    .trim()
    .replace(UNSAFE_PATH_CHARS, '_')
    .replace(/^[._]+/, '')
  return cleaned.length > 0 ? cleaned.slice(0, 120) : 'file'
}

/** `files/<safe-name>`, de-duplicated so two Versions of one filename stay two entities. */
export const allocateRoCrateContentPath = (
  filename: string,
  taken: ReadonlySet<string>
): string => {
  const safe = roCratePathSafeName(filename)
  // Dot extension kept so the payload is still obviously a csv/png/...; only the stem is suffixed.
  const dot = safe.lastIndexOf('.')
  const stem = dot > 0 ? safe.slice(0, dot) : safe
  const extension = dot > 0 ? safe.slice(dot) : ''
  let candidate = `${RO_CRATE_CONTENT_DIRECTORY}/${safe}`
  let index = 2
  while (taken.has(candidate)) {
    candidate = `${RO_CRATE_CONTENT_DIRECTORY}/${stem}~${index}${extension}`
    index += 1
  }
  return candidate
}

const idSafeSegment = (value: string): string =>
  value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'unnamed'

export const createActionIdFor = (content: RoCrateContentEntity): string =>
  `#create-${idSafeSegment(content.cratePath.slice(RO_CRATE_CONTENT_DIRECTORY.length + 1))}`

export const sessionEntityIdFor = (sessionId: string): string =>
  `#session-${idSafeSegment(sessionId)}`

// ---------------------------------------------------------------------------------------------
// Adapters: app-recorded provenance -> crate content records
// ---------------------------------------------------------------------------------------------

const inputVersionKey = (input: {
  sourceKind: 'artifact-version' | 'upload-version'
  sourceFileId: string
  inputFileVersionId: string
}): string => `${input.sourceKind}:${input.sourceFileId}:${input.inputFileVersionId}`

export const roCrateProvenanceFromArtifactVersion = (
  evidence: ArtifactVersionEvidence
): RoCrateFileProvenance => {
  const producer = evidence.producer
  return {
    sourceKind: 'artifact-version',
    projectId: evidence.project_id,
    appSessionId: evidence.app_session_id,
    artifactId: evidence.artifact_id,
    versionId: evidence.version_id,
    versionNumber: evidence.version_number,
    recordedSha256: evidence.checksum,
    recordedSizeBytes: evidence.size_bytes,
    createdAt: evidence.created_at,
    ...(evidence.agent_name ? { agentName: evidence.agent_name } : {}),
    ...(producer.state === 'available'
      ? {
          producerRunId: producer.producer_run_id,
          kernelKind: producer.kernel_kind
        }
      : {}),
    ...(evidence.reproduction_code ? { reproductionCode: evidence.reproduction_code } : {}),
    ...(evidence.environment
      ? {
          environment: {
            name: evidence.environment.environment_name,
            ...(evidence.environment.runtime_version
              ? { runtimeVersion: evidence.environment.runtime_version }
              : {}),
            manifestChecksum: evidence.environment.source_manifest_checksum
          }
        }
      : {}),
    inputs: evidence.inputs.map((input) => ({
      ordinal: input.ordinal,
      kind: input.source_kind,
      versionKey: inputVersionKey({
        sourceKind: input.source_kind,
        sourceFileId: input.source_file_id,
        inputFileVersionId: input.input_file_version_id
      }),
      filename: input.filename,
      sizeBytes: input.size_bytes,
      sha256: input.checksum,
      ...(input.content_type ? { contentType: input.content_type } : {})
    }))
  }
}

/**
 * One stored Artifact Version as a crate content record. Refuses a record whose bytes were never
 * hashed, because the crate must be able to repeat that hash.
 */
export const roCrateContentEntityFromArtifactVersion = (input: {
  evidence: ArtifactVersionEvidence
  cratePath: string
}): RoCrateContentEntity => {
  const { evidence } = input
  if (!evidence.checksum || !/^[a-f0-9]{64}$/.test(evidence.checksum)) {
    throw new Error(`Artifact Version ${evidence.version_id} has no recorded sha256.`)
  }
  return {
    cratePath: input.cratePath,
    name: evidence.filename,
    ...(evidence.content_type ? { contentType: evidence.content_type } : {}),
    sizeBytes: evidence.size_bytes,
    sha256: evidence.checksum,
    provenance: roCrateProvenanceFromArtifactVersion(evidence)
  }
}

/**
 * One Project File (an upload or a published artifact file) as a crate content record. Files with no
 * recorded checksum are refused for the same reason as above.
 */
export const roCrateContentEntityFromProjectFile = (input: {
  item: ProjectFileItem
  cratePath: string
}): RoCrateContentEntity => {
  const { item } = input
  const checksum = item.checksum
  if (!checksum || !/^[a-f0-9]{64}$/.test(checksum)) {
    throw new Error(`Project File ${item.id} has no recorded sha256.`)
  }
  const sourceVersionId = item.sourceVersionId
  return {
    cratePath: input.cratePath,
    name: item.name,
    ...(item.mimeType ? { contentType: item.mimeType } : {}),
    sizeBytes: item.size,
    sha256: checksum,
    provenance: {
      sourceKind: 'project-file',
      projectId: item.projectId,
      appSessionId: item.sessionId,
      sourceFileId: item.sourceFileId,
      ...(sourceVersionId ? { sourceVersionId } : {}),
      recordedSha256: checksum,
      recordedSizeBytes: item.size
    }
  }
}

/** The version locator the app already uses for one stored Version, reused verbatim in the crate. */
export const roCrateVersionLocator = (provenance: RoCrateFileProvenance): string | undefined => {
  if (!provenance.artifactId || !provenance.versionId) return undefined
  return createArtifactVersionLocator({
    projectId: provenance.projectId,
    appSessionId: provenance.appSessionId,
    artifactId: provenance.artifactId,
    versionId: provenance.versionId
  })
}

// ---------------------------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------------------------

const sha256TermDeclaration = (): Record<string, string> => ({
  sha256: RO_CRATE_SHA256_TERM_IRI
})

export const buildRoCrateMetadata = (input: RoCrateBuildInput): RoCrateMetadataDocument => {
  const graph: RoCrateJsonLdEntity[] = [
    // 1. Metadata File Descriptor (spec-mandated self-description).
    {
      '@id': RO_CRATE_METADATA_FILENAME,
      '@type': 'CreativeWork',
      conformsTo: { '@id': RO_CRATE_PROFILE_URL },
      about: { '@id': RO_CRATE_ROOT_DATASET_ID }
    }
  ]

  // Deterministic order: same stored Versions always produce the same document.
  const entities = [...input.entities].sort((left, right) =>
    left.cratePath.localeCompare(right.cratePath)
  )

  const entityIdByVersionKey = new Map<string, string>()
  for (const entity of entities) {
    const provenance = entity.provenance
    if (provenance.versionId && provenance.artifactId) {
      // Same key shape the app records for an artifact-version input, so a derived file can point at
      // its input when both Versions are in the crate.
      entityIdByVersionKey.set(
        `artifact-version:${provenance.artifactId}:${provenance.versionId}`,
        entity.cratePath
      )
    }
  }

  const softwareIds = new Map<string, string>()
  const agentIds = new Map<string, string>()
  const softwareEntities: RoCrateJsonLdEntity[] = []
  const agentEntities: RoCrateJsonLdEntity[] = []

  const appSoftwareId = input.app.url
  softwareIds.set(`app:${input.app.name}`, appSoftwareId)
  softwareEntities.push({
    '@id': appSoftwareId,
    '@type': 'SoftwareApplication',
    name: input.app.name,
    version: input.app.version,
    url: input.app.url
  })

  const contextEntities: RoCrateJsonLdEntity[] = []
  const actionEntities: RoCrateJsonLdEntity[] = []

  for (const content of entities) {
    const provenance = content.provenance
    const actionId = createActionIdFor(content)
    const result: RoCrateJsonLdReference[] = [{ '@id': content.cratePath }]

    const instruments: RoCrateJsonLdReference[] = [{ '@id': appSoftwareId }]

    if (provenance.kernelKind) {
      const key = `kernel:${provenance.kernelKind}`
      let id = softwareIds.get(key)
      if (!id) {
        id = `#environment-${idSafeSegment(provenance.kernelKind)}`
        softwareIds.set(key, id)
        softwareEntities.push({
          '@id': id,
          '@type': 'SoftwareApplication',
          name: `${provenance.kernelKind} kernel`,
          description: `Notebook kernel that ran the code producing this file.`
        })
      }
      instruments.push({ '@id': id })
    }

    if (provenance.environment) {
      const key = `environment:${provenance.environment.name}`
      let id = softwareIds.get(key)
      if (!id) {
        id = `#environment-${idSafeSegment(provenance.environment.name)}`
        softwareIds.set(key, id)
        softwareEntities.push({
          '@id': id,
          '@type': 'SoftwareApplication',
          name: provenance.environment.name,
          ...(provenance.environment.runtimeVersion
            ? { version: provenance.environment.runtimeVersion }
            : {}),
          ...(provenance.environment.manifestChecksum
            ? { identifier: provenance.environment.manifestChecksum }
            : {})
        })
      }
      instruments.push({ '@id': id })
    }

    if (provenance.agentName) {
      const key = `agent:${provenance.agentName}`
      let id = agentIds.get(key)
      if (!id) {
        id = `#agent-${idSafeSegment(provenance.agentName)}`
        agentIds.set(key, id)
        // The recording app cannot honestly call its automated author a person, so the agent is
        // modelled as the software it is; a human creator, when one is supplied, is a Person.
        agentEntities.push({
          '@id': id,
          '@type': 'SoftwareApplication',
          name: provenance.agentName,
          description: 'Coding agent that authored the code which produced this file.'
        })
      }
      instruments.push({ '@id': id })
    }

    const actionObjects: RoCrateJsonLdReference[] = []
    for (const record of provenance.inputs ?? []) {
      const knownId = entityIdByVersionKey.get(record.versionKey)
      if (knownId) {
        actionObjects.push({ '@id': knownId })
        continue
      }
      // The input is not in this crate (another Project, a reference PDF, an input whose Version was
      // never published). It is still named — an entity with its recorded hash and no bytes — so the
      // action never points at nothing.
      const stubId = `#input-${idSafeSegment(record.versionKey)}`
      contextEntities.push({
        '@id': stubId,
        '@type': 'CreativeWork',
        name: record.filename,
        ...(record.contentType ? { encodingFormat: record.contentType } : {}),
        contentSize: String(record.sizeBytes),
        sha256: record.sha256,
        description: `Input of a recorded run, stored as ${record.kind} and not copied into this crate.`
      })
      actionObjects.push({ '@id': stubId })
    }

    actionEntities.push({
      '@id': actionId,
      '@type': 'CreateAction',
      name: `produce ${content.name}`,
      ...(provenance.reproductionCode
        ? { description: `Recorded recipe: ${provenance.reproductionCode}` }
        : {}),
      ...(provenance.createdAt ? { endTime: provenance.createdAt } : {}),
      instrument: instruments,
      ...(actionObjects.length > 0 ? { object: actionObjects } : {}),
      result,
      ...(roCrateVersionLocator(provenance)
        ? { identifier: roCrateVersionLocator(provenance) as string }
        : {})
    })
  }

  const fileEntities: RoCrateJsonLdEntity[] = entities.map((content) => {
    const locator = roCrateVersionLocator(content.provenance)
    return {
      '@id': content.cratePath,
      '@type': 'File',
      name: content.name,
      ...(locator ? { identifier: locator } : {}),
      ...(content.contentType ? { encodingFormat: content.contentType } : {}),
      contentSize: String(content.sizeBytes),
      sha256: content.sha256,
      ...(content.provenance.createdAt ? { datePublished: content.provenance.createdAt } : {}),
      'prov:wasGeneratedBy': { '@id': createActionIdFor(content) },
      wasDerivedFrom: { '@id': RO_CRATE_ROOT_DATASET_ID }
    }
  })

  const hasPart: RoCrateJsonLdReference[] = entities.map((content) => ({
    '@id': content.cratePath
  }))
  const sessionRecords = input.sessions ?? []
  const mentions: RoCrateJsonLdReference[] = sessionRecords.map((session) => ({
    '@id': sessionEntityIdFor(session.id)
  }))

  const root: RoCrateJsonLdEntity = {
    '@id': RO_CRATE_ROOT_DATASET_ID,
    '@type': 'Dataset',
    name: input.name,
    description: input.description,
    datePublished: input.datePublished,
    conformsTo: { '@id': RO_CRATE_PROFILE_URL },
    identifier: input.projectId,
    hasPart,
    ...(mentions.length > 0 ? { mentions } : {}),
    ...(input.license ? { license: { '@id': input.license.id } } : {}),
    ...(input.publisher ? { publisher: { '@id': input.publisher.id } } : {}),
    ...(input.creators && input.creators.length > 0
      ? { author: input.creators.map((creator) => ({ '@id': creator.id })) }
      : {})
  }

  const creatorEntities: RoCrateJsonLdEntity[] = [
    ...(input.publisher
      ? [
          {
            '@id': input.publisher.id,
            '@type': input.publisher.type,
            name: input.publisher.name,
            ...(input.publisher.url ? { url: input.publisher.url } : {})
          } satisfies RoCrateJsonLdEntity
        ]
      : []),
    ...(input.creators ?? []).map(
      (creator) =>
        ({
          '@id': creator.id,
          '@type': creator.type,
          name: creator.name,
          ...(creator.url ? { url: creator.url } : {})
        }) satisfies RoCrateJsonLdEntity
    )
  ]

  const licenseEntity: RoCrateJsonLdEntity[] = input.license
    ? [
        {
          '@id': input.license.id,
          '@type': 'CreativeWork',
          name: input.license.name
        }
      ]
    : []

  const sessionEntity: RoCrateJsonLdEntity[] = sessionRecords.map((session) => ({
    '@id': sessionEntityIdFor(session.id),
    '@type': 'CreativeWork',
    name: session.title ?? session.id,
    identifier: session.id,
    description: 'Analysis session whose recorded runs produced the files in this crate.'
  }))

  return {
    '@context': [RO_CRATE_CONTEXT_URL, sha256TermDeclaration()],
    '@graph': [
      ...graph,
      root,
      ...fileEntities,
      ...actionEntities,
      ...softwareEntities,
      ...agentEntities,
      ...creatorEntities,
      ...licenseEntity,
      ...sessionEntity,
      ...contextEntities
    ]
  }
}

// ---------------------------------------------------------------------------------------------
// Validation: the decidable rules of the spec, plus this export's own traceability contract
// ---------------------------------------------------------------------------------------------

export type RoCrateAssertionLevel = 'spec-must' | 'spec-should' | 'export-contract'

export type RoCrateAssertion = {
  id: string
  level: RoCrateAssertionLevel
  /** The requirement this assertion decides, quoted from the spec or from the export contract. */
  requirement: string
  ok: boolean
  detail?: string
}

export type RoCrateValidationReport = {
  ok: boolean
  passed: number
  failed: number
  assertions: RoCrateAssertion[]
}

export type RoCratePayloadDigest = { sizeBytes: number; sha256: string }

export type RoCrateValidationInput = {
  document: RoCrateMetadataDocument
  /** Crate-relative paths of the payload files the crate holds under its root. The export side passes what
   * it just wrote; the read-only side passes what a crate this app did not write actually contains. */
  payloadPaths?: readonly string[]
  /** Recounted byte length and sha256 of each payload, keyed by its crate-relative path. */
  payloadDigests?: ReadonlyMap<string, RoCratePayloadDigest>
}

const RO_CRATE_REQUIREMENTS = {
  structure:
    'RO-Crate 1.1 §RO-Crate Structure: ro-crate-metadata.json MUST be in the crate root, and a valid graph MUST describe the Metadata File Descriptor and the Root Data Entity.',
  descriptor:
    'RO-Crate 1.1 §Root Data Entity: the Metadata File Descriptor MUST have @id ro-crate-metadata.json and @type CreativeWork, MUST have an about property referencing the Root Data Entity, and its conformsTo SHOULD be a versioned https://w3id.org/ro/crate/ permalink.',
  root: 'RO-Crate 1.1 §Root Data Entity: the Root Data Entity MUST be a Dataset whose @id ends with /, its datePublished MUST be an ISO 8601 string, and name/description SHOULD disambiguate the dataset.',
  dataEntities:
    'RO-Crate 1.1 §Data Entities: File entities MUST have "File" as a @type value and MUST be linked from the Root Data Entity through hasPart; Data Entities MUST be payload files inside the crate root or web-based, and contentSize/encodingFormat SHOULD describe the encoding.',
  contextual:
    'RO-Crate 1.1 §Contextual Entities: the @graph MUST NOT list two entities with the same @id, and a referenced entity SHOULD be described in the same metadata file and linked from at least one other entity.',
  provenance:
    'RO-Crate 1.1 §Provenance of entities: software used to create a file SHOULD be a SoftwareApplication with a version, associated with the file through a CreateAction instrument/result, and an Action SHOULD have a name and an endTime.',
  exportContract:
    'PureScience export contract: every content file in the crate is a byte-identical copy of one stored Version, repeats that Version\u2019s recorded sha256, and names the Version it came from.'
} as const

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const typeListOf = (entity: RoCrateJsonLdEntity): string[] =>
  Array.isArray(entity['@type']) ? entity['@type'] : [entity['@type']]

const referencesOf = (value: unknown, out: string[] = []): string[] => {
  if (Array.isArray(value)) {
    for (const item of value) referencesOf(item, out)
    return out
  }
  if (isRecord(value)) {
    const id = value['@id']
    if (typeof id === 'string') out.push(id)
    for (const [key, child] of Object.entries(value)) {
      if (key !== '@id') referencesOf(child, out)
    }
  }
  return out
}

const hasUriScheme = (value: string): boolean => /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)

const ISO_8601_DATE =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/

const SHA256_HEX = /^[a-f0-9]{64}$/

export const validateRoCrate = (input: RoCrateValidationInput): RoCrateValidationReport => {
  const { document } = input
  const graph = Array.isArray(document['@graph']) ? document['@graph'] : []
  const assertions: RoCrateAssertion[] = []

  const assert = (
    id: string,
    level: RoCrateAssertionLevel,
    requirement: string,
    ok: boolean,
    detail?: string
  ): void => {
    assertions.push({ id, level, requirement, ok, ...(detail ? { detail } : {}) })
  }

  // --- graph-level shape -------------------------------------------------------------------
  const flattened = graph.filter((entity) => isRecord(entity) && typeof entity['@id'] === 'string')
  assert(
    'graph-flattened-entries',
    'spec-must',
    RO_CRATE_REQUIREMENTS.structure,
    flattened.length === graph.length && graph.length > 0,
    `@graph entries: ${graph.length}, of which addressable objects: ${flattened.length}`
  )

  const ids = graph.map((entity) => entity['@id'])
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index)
  assert(
    'no-duplicate-entity-ids',
    'spec-must',
    RO_CRATE_REQUIREMENTS.contextual,
    duplicates.length === 0,
    duplicates.length > 0 ? `duplicated @id: ${[...new Set(duplicates)].join(', ')}` : undefined
  )

  const byId = new Map<string, RoCrateJsonLdEntity>()
  for (const entity of graph) if (!byId.has(entity['@id'])) byId.set(entity['@id'], entity)

  const contextEntries = Array.isArray(document['@context'])
    ? document['@context']
    : [document['@context']]
  assert(
    'context-references-ro-crate-profile',
    'spec-should',
    RO_CRATE_REQUIREMENTS.structure,
    contextEntries.includes(RO_CRATE_CONTEXT_URL),
    `@context: ${JSON.stringify(contextEntries)}`
  )

  // --- descriptor --------------------------------------------------------------------------
  const descriptor =
    graph.find(
      (entity) =>
        typeListOf(entity).includes('CreativeWork') &&
        referencesOf(entity['conformsTo']).some((id) => id.startsWith('https://w3id.org/ro/crate/'))
    ) ?? graph.find((entity) => entity['@id'] === RO_CRATE_METADATA_FILENAME)

  assert(
    'metadata-file-descriptor-present',
    'spec-must',
    RO_CRATE_REQUIREMENTS.structure,
    descriptor !== undefined,
    descriptor
      ? `descriptor @id: ${descriptor['@id']}`
      : 'no CreativeWork with a RO-Crate conformsTo'
  )
  assert(
    'metadata-descriptor-id',
    'spec-must',
    RO_CRATE_REQUIREMENTS.descriptor,
    descriptor?.['@id'] === RO_CRATE_METADATA_FILENAME,
    `descriptor @id: ${String(descriptor?.['@id'])}`
  )
  assert(
    'metadata-descriptor-type',
    'spec-must',
    RO_CRATE_REQUIREMENTS.descriptor,
    descriptor !== undefined && typeListOf(descriptor).includes('CreativeWork'),
    descriptor ? `descriptor @type: ${JSON.stringify(descriptor['@type'])}` : undefined
  )

  // --- root data entity --------------------------------------------------------------------
  const root = byId.get(RO_CRATE_ROOT_DATASET_ID)
  assert(
    'root-data-entity-present',
    'spec-must',
    RO_CRATE_REQUIREMENTS.structure,
    root !== undefined,
    root ? 'found ./' : 'no entity with @id ./'
  )
  assert(
    'root-data-entity-is-dataset',
    'spec-must',
    RO_CRATE_REQUIREMENTS.root,
    root !== undefined && typeListOf(root).includes('Dataset'),
    root ? `root @type: ${JSON.stringify(root['@type'])}` : undefined
  )
  assert(
    'root-data-entity-id-slashed',
    'spec-must',
    RO_CRATE_REQUIREMENTS.root,
    root !== undefined && root['@id'].endsWith('/'),
    `root @id: ${String(root?.['@id'])}`
  )
  assert(
    'root-date-published-iso8601',
    'spec-must',
    RO_CRATE_REQUIREMENTS.root,
    typeof root?.['datePublished'] === 'string' && ISO_8601_DATE.test(root['datePublished']),
    `datePublished: ${JSON.stringify(root?.['datePublished'])}`
  )
  assert(
    'root-name-and-description',
    'spec-should',
    RO_CRATE_REQUIREMENTS.root,
    typeof root?.['name'] === 'string' &&
      (root['name'] as string).length > 0 &&
      typeof root?.['description'] === 'string' &&
      (root['description'] as string).length > 0
  )
  assert(
    'metadata-descriptor-about-root',
    'spec-must',
    RO_CRATE_REQUIREMENTS.descriptor,
    descriptor !== undefined &&
      referencesOf(descriptor['about']).length > 0 &&
      referencesOf(descriptor['about']).includes(RO_CRATE_ROOT_DATASET_ID),
    `about: ${JSON.stringify(descriptor?.['about'])}`
  )
  assert(
    'metadata-descriptor-conforms-to-profile',
    'spec-should',
    RO_CRATE_REQUIREMENTS.descriptor,
    descriptor !== undefined &&
      referencesOf(descriptor['conformsTo']).some((id) => id === RO_CRATE_PROFILE_URL),
    `conformsTo: ${JSON.stringify(descriptor?.['conformsTo'])}`
  )

  const licenseRefs = root ? referencesOf(root['license']) : []
  assert(
    'root-license-described',
    'spec-should',
    RO_CRATE_REQUIREMENTS.root,
    licenseRefs.length === 0 || licenseRefs.every((id) => byId.has(id)),
    licenseRefs.length > 0 ? `license: ${licenseRefs.join(', ')}` : 'no license declared'
  )

  // --- data entities -----------------------------------------------------------------------
  const pathEntities = graph.filter(
    (entity) =>
      typeof entity['@id'] === 'string' &&
      (entity['@id'].startsWith(`${RO_CRATE_CONTENT_DIRECTORY}/`) ||
        (input.payloadPaths ?? []).includes(entity['@id']))
  )
  const misTyped = pathEntities.filter((entity) => !typeListOf(entity).includes('File'))
  assert(
    'file-entities-typed-file',
    'spec-must',
    RO_CRATE_REQUIREMENTS.dataEntities,
    misTyped.length === 0,
    misTyped.length > 0 ? `not typed File: ${misTyped.map((e) => e['@id']).join(', ')}` : undefined
  )

  // hasPart reachability: root -> parts, and a Dataset part may carry nested parts.
  const reachable = new Set<string>()
  const visitParts = (entityId: string): void => {
    const entity = byId.get(entityId)
    if (!entity) return
    for (const partId of referencesOf(entity['hasPart'])) {
      if (reachable.has(partId)) continue
      reachable.add(partId)
      visitParts(partId)
    }
  }
  visitParts(RO_CRATE_ROOT_DATASET_ID)
  const unlinked = pathEntities.filter((entity) => !reachable.has(entity['@id']))
  assert(
    'files-linked-from-root',
    'spec-must',
    RO_CRATE_REQUIREMENTS.dataEntities,
    unlinked.length === 0,
    unlinked.length > 0
      ? `not reachable from ./: ${unlinked.map((e) => e['@id']).join(', ')}`
      : undefined
  )

  const nonPayloadPaths = pathEntities.filter(
    (entity) =>
      hasUriScheme(entity['@id']) || entity['@id'].startsWith('/') || entity['@id'].includes('..')
  )
  assert(
    'data-entities-are-payload-or-web',
    'spec-must',
    RO_CRATE_REQUIREMENTS.dataEntities,
    nonPayloadPaths.length === 0,
    nonPayloadPaths.length > 0
      ? `ids that are neither crate-relative nor absolute: ${nonPayloadPaths.map((e) => e['@id']).join(', ')}`
      : undefined
  )

  const missingCore = pathEntities.filter(
    (entity) =>
      typeof entity['contentSize'] !== 'string' ||
      !/^\d+$/.test(entity['contentSize'] as string) ||
      typeof entity['encodingFormat'] !== 'string'
  )
  assert(
    'file-content-size-and-format',
    'spec-should',
    RO_CRATE_REQUIREMENTS.dataEntities,
    missingCore.length === 0,
    missingCore.length > 0
      ? `missing contentSize/encodingFormat: ${missingCore.map((e) => e['@id']).join(', ')}`
      : undefined
  )

  // --- references resolve ------------------------------------------------------------------
  const dangling: string[] = []
  for (const entity of graph) {
    for (const reference of referencesOf(entity)) {
      if (reference === entity['@id']) continue
      if (hasUriScheme(reference)) continue
      if (byId.has(reference)) continue
      dangling.push(`${entity['@id']} -> ${reference}`)
    }
  }
  assert(
    'references-resolve',
    'spec-should',
    RO_CRATE_REQUIREMENTS.contextual,
    dangling.length === 0,
    dangling.length > 0 ? `unresolved: ${[...new Set(dangling)].slice(0, 8).join(', ')}` : undefined
  )

  const unreferenced = graph.filter((entity) => {
    if (
      entity['@id'] === RO_CRATE_ROOT_DATASET_ID ||
      entity['@id'] === RO_CRATE_METADATA_FILENAME
    ) {
      return false
    }
    return !graph.some((other) => other !== entity && referencesOf(other).includes(entity['@id']))
  })
  assert(
    'contextual-entities-linked',
    'spec-should',
    RO_CRATE_REQUIREMENTS.contextual,
    unreferenced.length === 0,
    unreferenced.length > 0
      ? `linked from nowhere: ${unreferenced
          .map((e) => e['@id'])
          .slice(0, 8)
          .join(', ')}`
      : undefined
  )

  // --- provenance --------------------------------------------------------------------------
  const actions = graph.filter((entity) => typeListOf(entity).includes('CreateAction'))
  const badActions = actions.filter(
    (entity) =>
      referencesOf(entity['result']).length === 0 ||
      referencesOf(entity['instrument']).length === 0 ||
      typeof entity['name'] !== 'string'
  )
  assert(
    'create-action-complete',
    'spec-should',
    RO_CRATE_REQUIREMENTS.provenance,
    badActions.length === 0,
    badActions.length > 0
      ? `incomplete actions: ${badActions.map((e) => e['@id']).join(', ')}`
      : undefined
  )

  const software = graph.filter((entity) => typeListOf(entity).includes('SoftwareApplication'))
  const unnamedSoftware = software.filter(
    (entity) => typeof entity['name'] !== 'string' || (entity['name'] as string).length === 0
  )
  assert(
    'software-application-named',
    'spec-should',
    RO_CRATE_REQUIREMENTS.provenance,
    unnamedSoftware.length === 0,
    unnamedSoftware.length > 0
      ? `nameless: ${unnamedSoftware.map((e) => e['@id']).join(', ')}`
      : undefined
  )

  // --- export contract ---------------------------------------------------------------------
  assert(
    'crate-describes-at-least-one-payload',
    'export-contract',
    RO_CRATE_REQUIREMENTS.exportContract,
    pathEntities.length > 0 && actions.length > 0 && software.length > 0,
    `payloads: ${pathEntities.length}, actions: ${actions.length}, software: ${software.length}`
  )

  const payloadDigests = input.payloadDigests
  const withoutHash = pathEntities.filter(
    (entity) => typeof entity['sha256'] !== 'string' || !SHA256_HEX.test(entity['sha256'] as string)
  )
  assert(
    'file-sha256-recorded',
    'export-contract',
    RO_CRATE_REQUIREMENTS.exportContract,
    withoutHash.length === 0,
    withoutHash.length > 0 ? `no sha256: ${withoutHash.map((e) => e['@id']).join(', ')}` : undefined
  )

  if (payloadDigests) {
    const mismatchedHash = pathEntities.filter((entity) => {
      const digest = payloadDigests.get(entity['@id'])
      return !digest || digest.sha256 !== entity['sha256']
    })
    assert(
      'file-sha256-matches-copied-bytes',
      'export-contract',
      RO_CRATE_REQUIREMENTS.exportContract,
      mismatchedHash.length === 0,
      mismatchedHash.length > 0
        ? `crate file differs from its declared sha256: ${mismatchedHash.map((e) => e['@id']).join(', ')}`
        : undefined
    )
    const mismatchedSize = pathEntities.filter((entity) => {
      const digest = payloadDigests.get(entity['@id'])
      return !digest || String(digest.sizeBytes) !== entity['contentSize']
    })
    assert(
      'file-content-size-matches-copied-bytes',
      'export-contract',
      RO_CRATE_REQUIREMENTS.exportContract,
      mismatchedSize.length === 0,
      mismatchedSize.length > 0
        ? `contentSize disagrees with copied bytes: ${mismatchedSize.map((e) => e['@id']).join(', ')}`
        : undefined
    )
  }

  if (input.payloadPaths) {
    const declared = new Set(pathEntities.map((entity) => entity['@id']))
    const undescribed = input.payloadPaths.filter((path) => !declared.has(path))
    assert(
      'every-payload-described',
      'export-contract',
      RO_CRATE_REQUIREMENTS.exportContract,
      undescribed.length === 0,
      undescribed.length > 0 ? `payload without an entity: ${undescribed.join(', ')}` : undefined
    )
  }

  const actionsByResult = new Set<string>()
  for (const action of actions)
    for (const id of referencesOf(action['result'])) actionsByResult.add(id)
  const untraced = pathEntities.filter((entity) => !actionsByResult.has(entity['@id']))
  assert(
    'no-payload-without-action',
    'export-contract',
    RO_CRATE_REQUIREMENTS.exportContract,
    untraced.length === 0,
    untraced.length > 0
      ? `file with no producing CreateAction: ${untraced.map((e) => e['@id']).join(', ')}`
      : undefined
  )

  const identifiedActions = actions.filter((entity) => typeof entity['identifier'] === 'string')
  const traceable = actions.length === 0 || identifiedActions.length > 0
  assert(
    'file-provenance-names-stored-version',
    'export-contract',
    RO_CRATE_REQUIREMENTS.exportContract,
    traceable,
    actions.length === 0
      ? 'no CreateAction to trace'
      : `${identifiedActions.length}/${actions.length} actions name a stored Version`
  )

  const filesWithoutLocator = pathEntities.filter(
    (entity) =>
      typeof entity['identifier'] !== 'string' || (entity['identifier'] as string).length === 0
  )
  assert(
    'file-names-stored-version',
    'export-contract',
    RO_CRATE_REQUIREMENTS.exportContract,
    filesWithoutLocator.length === 0,
    filesWithoutLocator.length > 0
      ? `File entity without a stored-Version locator: ${filesWithoutLocator.map((e) => e['@id']).join(', ')}`
      : undefined
  )

  const failed = assertions.filter((assertion) => !assertion.ok).length
  return {
    ok: failed === 0,
    passed: assertions.length - failed,
    failed,
    assertions
  }
}

export const failedRoCrateAssertions = (report: RoCrateValidationReport): RoCrateAssertion[] =>
  report.assertions.filter((assertion) => !assertion.ok)
