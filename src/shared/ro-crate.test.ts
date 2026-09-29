import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import type { ArtifactVersionEvidence } from './artifact-provenance'
import {
  RO_CRATE_CONTEXT_URL,
  RO_CRATE_METADATA_FILENAME,
  RO_CRATE_PROFILE_URL,
  RO_CRATE_ROOT_DATASET_ID,
  RO_CRATE_SHA256_TERM_IRI,
  allocateRoCrateContentPath,
  buildRoCrateMetadata,
  failedRoCrateAssertions,
  roCrateContentEntityFromArtifactVersion,
  roCrateContentEntityFromProjectFile,
  roCrateVersionLocator,
  validateRoCrate,
  type RoCrateContentEntity,
  type RoCrateMetadataDocument,
  type RoCratePayloadDigest
} from './ro-crate'

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

// A real Artifact Version evidence record (the shape `src/main/artifacts/provenance-repository.ts`
// publishes to `.provenance/<artifactId>/versions/<versionId>/evidence.json`), filled with values a
// reader can check by hand.
const evidenceFor = (
  overrides: Partial<ArtifactVersionEvidence> & { filename: string; body: string }
): ArtifactVersionEvidence => {
  const { body, filename, ...rest } = overrides
  const checksum = sha256(body)
  return {
    schema_version: 1,
    project_id: 'project-1',
    app_session_id: 'session-1',
    artifact_id: 'artifact-1',
    version_id: 'version-1',
    version_number: 1,
    filename,
    content_type: 'text/plain',
    size_bytes: body.length,
    checksum,
    created_at: '2026-09-05T06:31:00.000Z',
    agent_name: 'Agent',
    conversation: {
      root_frame_id: 'root-frame-1',
      agent_frame_id: 'agent-frame-1',
      message_branch_id: 'branch-1',
      runtime_segment_id: 'segment-1',
      prompt_message_id: 'message-1'
    },
    is_user_upload: false,
    execution_status: { state: 'available' },
    inputs: [],
    producer: {
      state: 'available',
      notebook_session_id: 'session-1',
      producer_run_id: 'run-1',
      run_index: 0,
      kernel_kind: 'python',
      association_method: 'agent-declared-and-session-validated'
    },
    environment_status: { state: 'unavailable', reason: 'environment-not-supported' },
    ...rest
  }
}

const contentFor = (
  evidence: ArtifactVersionEvidence,
  cratePath = `files/${evidence.filename}`
): RoCrateContentEntity => roCrateContentEntityFromArtifactVersion({ evidence, cratePath })

const buildFor = (entities: readonly RoCrateContentEntity[]): RoCrateMetadataDocument =>
  buildRoCrateMetadata({
    projectId: 'project-1',
    name: 'Project One',
    description: 'Files produced for project one.',
    datePublished: '2026-09-30T00:00:00.000Z',
    app: { name: 'PureScience', version: '1.75.0', url: 'https://www.zerolink.com/purescience' },
    publisher: {
      type: 'Organization',
      id: 'https://www.zerolink.com',
      name: 'zerolink'
    },
    license: { id: 'https://spdx.org/licenses/Apache-2.0', name: 'Apache License 2.0' },
    sessions: [{ id: 'session-1' }],
    entities
  })

const entityById = (
  document: RoCrateMetadataDocument,
  id: string
): RoCrateMetadataDocument['@graph'][number] | undefined =>
  document['@graph'].find((entity) => entity['@id'] === id)

const digestMap = (document: RoCrateMetadataDocument): Map<string, RoCratePayloadDigest> => {
  const digests = new Map<string, RoCratePayloadDigest>()
  for (const entity of document['@graph']) {
    if (entity['@type'] === 'File') {
      digests.set(entity['@id'], {
        sizeBytes: Number(entity['contentSize']),
        sha256: String(entity['sha256'])
      })
    }
  }
  return digests
}

const payloadPathsOf = (document: RoCrateMetadataDocument): string[] =>
  document['@graph'].filter((entity) => entity['@type'] === 'File').map((entity) => entity['@id'])

describe('RO-Crate 1.1 metadata', () => {
  const evidence = evidenceFor({ filename: 'assay.csv', body: 'a,b\n1,2\n' })
  const document = buildFor([contentFor(evidence)])

  it('declares the RO-Crate 1.1 context by reference, with sha256 declared locally', () => {
    expect(document['@context'][0]).toBe(RO_CRATE_CONTEXT_URL)
    expect(document['@context']).toContainEqual({ sha256: RO_CRATE_SHA256_TERM_IRI })
  })

  it('self-describes through the Metadata File Descriptor required by the spec', () => {
    const descriptor = entityById(document, RO_CRATE_METADATA_FILENAME)
    expect(descriptor).toBeDefined()
    expect(descriptor?.['@type']).toBe('CreativeWork')
    expect(descriptor?.['about']).toEqual({ '@id': RO_CRATE_ROOT_DATASET_ID })
    expect(descriptor?.['conformsTo']).toEqual({ '@id': RO_CRATE_PROFILE_URL })
  })

  it('describes the Root Data Entity as a Dataset whose @id ends with /', () => {
    const root = entityById(document, RO_CRATE_ROOT_DATASET_ID)
    expect(root?.['@type']).toBe('Dataset')
    expect(String(root?.['@id']).endsWith('/')).toBe(true)
    expect(root?.['name']).toBe('Project One')
    expect(root?.['description']).toBeTypeOf('string')
    expect(root?.['datePublished']).toBe('2026-09-30T00:00:00.000Z')
  })

  it('links the file to the Root Data Entity through hasPart and types it File', () => {
    const root = entityById(document, RO_CRATE_ROOT_DATASET_ID)
    expect(root?.['hasPart']).toEqual([{ '@id': 'files/assay.csv' }])
    const file = entityById(document, 'files/assay.csv')
    expect(file?.['@type']).toBe('File')
    expect(file?.['contentSize']).toBe(String(evidence.size_bytes))
    expect(file?.['encodingFormat']).toBe('text/plain')
    expect(file?.['sha256']).toBe(evidence.checksum)
  })

  it('records how the file was produced: a CreateAction with instrument, result and version id', () => {
    const actionId = '#create-assay.csv'
    const file = entityById(document, 'files/assay.csv')
    expect(file?.['prov:wasGeneratedBy']).toEqual({ '@id': actionId })
    expect(file?.['identifier']).toBe(roCrateVersionLocator(contentFor(evidence).provenance))
    const action = entityById(document, actionId)
    expect(action?.['@type']).toBe('CreateAction')
    expect(action?.['result']).toEqual([{ '@id': 'files/assay.csv' }])
    expect(action?.['endTime']).toBe('2026-09-05T06:31:00.000Z')
    expect(action?.['identifier']).toBe('artifact-version:project-1/session-1/artifact-1/version-1')
    const instrumentIds = (action?.['instrument'] as { '@id': string }[]).map((ref) => ref['@id'])
    expect(instrumentIds).toContain('https://www.zerolink.com/purescience')
    expect(instrumentIds).toContain('#environment-python')
    expect(instrumentIds).toContain('#agent-Agent')
  })

  it('models the producing software and the licence as described contextual entities', () => {
    expect(entityById(document, 'https://www.zerolink.com')?.['@type']).toBe('Organization')
    expect(entityById(document, 'https://spdx.org/licenses/Apache-2.0')?.['name']).toBe(
      'Apache License 2.0'
    )
    const app = entityById(document, 'https://www.zerolink.com/purescience')
    expect(app?.['@type']).toBe('SoftwareApplication')
    expect(app?.['version']).toBe('1.75.0')
  })

  it('passes every assertion when the payload on disk matches the metadata', () => {
    const report = validateRoCrate({
      document,
      payloadPaths: payloadPathsOf(document),
      payloadDigests: digestMap(document)
    })
    expect(failedRoCrateAssertions(report)).toEqual([])
    expect(report.ok).toBe(true)
    expect(report.failed).toBe(0)
  })

  it('refuses a content record whose bytes were never hashed', () => {
    expect(() =>
      roCrateContentEntityFromArtifactVersion({
        evidence: evidenceFor({ filename: 'x.txt', body: 'x', checksum: '' }),
        cratePath: 'files/x.txt'
      })
    ).toThrow(/no recorded sha256/)
  })

  it('refuses a Project File whose bytes were never hashed', () => {
    expect(() =>
      roCrateContentEntityFromProjectFile({
        item: {
          id: 'file-1',
          source: 'upload',
          sourceFileId: 'upload-1',
          projectId: 'project-1',
          sessionId: 'session-1',
          name: 'notes.md',
          path: 'upload-version:project-1/session-1/upload-1/version-1',
          size: 12,
          sortAtMs: 1
        },
        cratePath: 'files/notes.md'
      })
    ).toThrow(/no recorded sha256/)
  })

  it('accepts a Project File once its checksum is recorded', () => {
    const body = '# notes\n'
    const entity = roCrateContentEntityFromProjectFile({
      item: {
        id: 'file-1',
        source: 'upload',
        sourceFileId: 'upload-1',
        sourceVersionId: 'upload-version-1',
        checksum: sha256(body),
        projectId: 'project-1',
        sessionId: 'session-1',
        name: 'notes.md',
        path: 'upload-version:project-1/session-1/upload-1/upload-version-1',
        mimeType: 'text/markdown',
        size: body.length,
        sortAtMs: 1
      },
      cratePath: 'files/notes.md'
    })
    expect(entity.sha256).toBe(sha256(body))
    expect(entity.provenance.sourceKind).toBe('project-file')
  })

  it('keeps two Versions of one filename as two entities with distinct crate paths', () => {
    const taken = new Set<string>([RO_CRATE_METADATA_FILENAME])
    const first = allocateRoCrateContentPath('report.md', taken)
    taken.add(first)
    const second = allocateRoCrateContentPath('report.md', taken)
    expect(first).toBe('files/report.md')
    expect(second).toBe('files/report~2.md')
  })

  it('rewrites a name that JSON-LD would have to percent-encode into a literal path', () => {
    const path = allocateRoCrateContentPath('图 1 final/帧.png', new Set())
    expect(path).toBe('files/1_final_.png')
    expect(encodeURI(path)).toBe(path)
  })

  it('names an input that is not in the crate instead of leaving a dangling reference', () => {
    const input = evidenceFor({ filename: 'input.csv', body: 'raw\n' })
    const producer = evidenceFor({
      filename: 'derived.csv',
      body: 'derived\n',
      version_id: 'version-2',
      artifact_id: 'artifact-2',
      inputs: [
        {
          ordinal: 0,
          input_file_version_id: 'input-version-9',
          source_kind: 'upload-version',
          source_file_id: 'upload-9',
          source_project_id: 'project-1',
          source_session_id: 'session-1',
          filename: input.filename,
          size_bytes: input.size_bytes,
          checksum: input.checksum,
          storage_key: 'uploads/project-1/session-1/upload-9/input-version-9',
          strongest_association: 'turn-attached'
        } satisfies ArtifactVersionEvidence['inputs'][number]
      ]
    })
    const doc = buildFor([contentFor(input), contentFor(producer)])
    const action = entityById(doc, '#create-derived.csv')
    const objects = (action?.['object'] as { '@id': string }[]).map((ref) => ref['@id'])
    expect(objects).toEqual(['#input-upload-version-upload-9-input-version-9'])
    const report = validateRoCrate({
      document: doc,
      payloadPaths: payloadPathsOf(doc),
      payloadDigests: digestMap(doc)
    })
    expect(failedRoCrateAssertions(report)).toEqual([])
  })

  it('points at the input entity when the input Version is itself in the crate', () => {
    const input = evidenceFor({ filename: 'input.csv', body: 'raw\n' })
    const producer = evidenceFor({
      filename: 'derived.csv',
      body: 'derived\n',
      version_id: 'version-2',
      artifact_id: 'artifact-1',
      version_number: 2,
      inputs: [
        {
          ordinal: 0,
          input_file_version_id: 'version-1',
          source_kind: 'artifact-version',
          source_file_id: 'artifact-1',
          source_project_id: 'project-1',
          source_session_id: 'session-1',
          filename: input.filename,
          size_bytes: input.size_bytes,
          checksum: input.checksum,
          storage_key: 'artifacts/project-1/session-1/.provenance/artifact-1/versions/version-1',
          strongest_association: 'turn-attached'
        } satisfies ArtifactVersionEvidence['inputs'][number]
      ]
    })
    const doc = buildFor([contentFor(input), contentFor(producer)])
    const action = entityById(doc, '#create-derived.csv')
    expect(action?.['object']).toEqual([{ '@id': 'files/input.csv' }])
    expect(entityById(doc, 'files/input.csv')).toBeDefined()
  })

  it('always emits the app as a versioned SoftwareApplication', () => {
    const app = entityById(document, 'https://www.zerolink.com/purescience')
    expect(app?.['name']).toBe('PureScience')
    expect(app?.['version']).toBe('1.75.0')
    expect(app?.['url']).toBe('https://www.zerolink.com/purescience')
  })
})

describe('validateRoCrate', () => {
  const evidence = evidenceFor({ filename: 'assay.csv', body: 'a,b\n1,2\n' })
  const document = buildFor([contentFor(evidence)])
  const payloadPaths = payloadPathsOf(document)
  const payloadDigests = digestMap(document)

  const ASSERTION_LEVELS: readonly string[] = ['spec-must', 'spec-should', 'export-contract']

  it('uses a closed set of assertion levels, each quoting its requirement', () => {
    const report = validateRoCrate({ document, payloadPaths, payloadDigests })
    expect(report.assertions.length).toBeGreaterThan(10)
    for (const assertion of report.assertions) {
      expect(ASSERTION_LEVELS).toContain(assertion.level)
      expect(assertion.requirement.length).toBeGreaterThan(20)
    }
  })

  it('fails a dangling reference', () => {
    const broken: RoCrateMetadataDocument = {
      ...document,
      '@graph': document['@graph'].map((entity) =>
        entity['@id'] === '#create-assay.csv'
          ? { ...entity, instrument: [{ '@id': '#environment-nope' }] }
          : entity
      )
    }
    const report = validateRoCrate({ document: broken, payloadPaths, payloadDigests })
    expect(report.ok).toBe(false)
    expect(failedRoCrateAssertions(report).map((a) => a.id)).toContain('references-resolve')
  })

  it('fails a duplicated @id', () => {
    const root = entityById(document, RO_CRATE_ROOT_DATASET_ID)
    const broken: RoCrateMetadataDocument = {
      ...document,
      '@graph': [...document['@graph'], { ...(root as RoCrateMetadataDocument['@graph'][number]) }]
    }
    const report = validateRoCrate({ document: broken, payloadPaths, payloadDigests })
    expect(failedRoCrateAssertions(report).map((a) => a.id)).toContain('no-duplicate-entity-ids')
  })

  it('fails when a File entity carries no sha256', () => {
    const broken: RoCrateMetadataDocument = {
      ...document,
      '@graph': document['@graph'].map((entity) => {
        if (entity['@id'] !== 'files/assay.csv') return entity
        const { sha256: _sha256, ...rest } = entity
        return rest
      })
    }
    const report = validateRoCrate({ document: broken, payloadPaths, payloadDigests })
    expect(failedRoCrateAssertions(report).map((a) => a.id)).toContain('file-sha256-recorded')
  })

  it('fails when the copied bytes do not match the declared sha256', () => {
    const tampered = new Map(payloadDigests)
    tampered.set('files/assay.csv', { sizeBytes: 8, sha256: sha256('other bytes') })
    const report = validateRoCrate({ document, payloadPaths, payloadDigests: tampered })
    const failed = failedRoCrateAssertions(report).map((a) => a.id)
    expect(failed).toContain('file-sha256-matches-copied-bytes')
  })

  it('fails when a payload sits in the crate with no entity describing it', () => {
    const report = validateRoCrate({
      document,
      payloadPaths: [...payloadPaths, 'files/unlisted.bin'],
      payloadDigests
    })
    expect(failedRoCrateAssertions(report).map((a) => a.id)).toContain('every-payload-described')
  })

  it('fails when a File is not reachable from the root through hasPart', () => {
    const broken: RoCrateMetadataDocument = {
      ...document,
      '@graph': document['@graph'].map((entity) =>
        entity['@id'] === RO_CRATE_ROOT_DATASET_ID ? { ...entity, hasPart: [] } : entity
      )
    }
    const report = validateRoCrate({ document: broken, payloadPaths, payloadDigests })
    expect(failedRoCrateAssertions(report).map((a) => a.id)).toContain('files-linked-from-root')
  })

  it('fails when the descriptor no longer names its own file', () => {
    const broken: RoCrateMetadataDocument = {
      ...document,
      '@graph': document['@graph'].map((entity) =>
        entity['@id'] === RO_CRATE_METADATA_FILENAME
          ? { ...entity, '@id': 'metadata.json' }
          : entity
      )
    }
    const report = validateRoCrate({ document: broken, payloadPaths, payloadDigests })
    const failed = failedRoCrateAssertions(report).map((a) => a.id)
    // The entity is still findable by its conformsTo, so only the mandated @id is reported wrong.
    expect(failed).toContain('metadata-descriptor-id')
    expect(failed).not.toContain('metadata-file-descriptor-present')
  })

  it('fails when datePublished is not an ISO 8601 string', () => {
    const broken: RoCrateMetadataDocument = {
      ...document,
      '@graph': document['@graph'].map((entity) =>
        entity['@id'] === RO_CRATE_ROOT_DATASET_ID
          ? { ...entity, datePublished: 'September 30, 2026' }
          : entity
      )
    }
    const report = validateRoCrate({ document: broken, payloadPaths, payloadDigests })
    expect(failedRoCrateAssertions(report).map((a) => a.id)).toContain(
      'root-date-published-iso8601'
    )
  })

  it('fails a crate with no payload at all', () => {
    const report = validateRoCrate({ document: buildFor([]) })
    expect(failedRoCrateAssertions(report).map((a) => a.id)).toContain(
      'crate-describes-at-least-one-payload'
    )
  })
})
