import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  MarketplaceRepository,
  type MarketplaceInstallProvenance,
  type StoredMarketplaceSource
} from './repository'
import {
  marketplaceKeyFingerprint,
  parseMarketplaceRelease,
  parseMarketplaceRoot,
  parseMarketplaceSignature,
  sha256,
  verifyMarketplaceRoot
} from './protocol'
import { MarketplaceService } from './service'
import { OFFICIAL_MARKETPLACE_SOURCE } from './official-source'

const makeSource = (overrides: Partial<StoredMarketplaceSource> = {}): StoredMarketplaceSource => ({
  id: 'github-test-source',
  kind: 'github',
  repositoryUrl: 'https://github.com/example/marketplace',
  owner: 'example',
  repository: 'marketplace',
  ref: 'main',
  marketplaceId: 'test-marketplace',
  name: 'Test Marketplace',
  keyId: 'test-key',
  publicKey: 'MCowBQYDK2VwAyEA8Jt1UypmPMFX0N8u8QJdJzRkmEwX2b0kK0v6Qy6iN4Q=',
  keyFingerprint: 'a'.repeat(64),
  createdAt: '2026-08-18T00:00:00.000Z',
  ...overrides
})

const makeProvenance = (
  overrides: Partial<MarketplaceInstallProvenance> = {}
): MarketplaceInstallProvenance => ({
  sourceId: 'github-test-source',
  specialistId: 'example-specialist',
  publisher: 'Example',
  version: '1.0.0',
  releasePath: 'releases/specialist-1.0.0.json',
  releaseDigest: 'b'.repeat(64),
  artifactDigest: 'c'.repeat(64),
  installedArchiveDigest: 'd'.repeat(64),
  upstreamCommit: 'e'.repeat(40),
  selectedSkillIds: ['skill-a'],
  selectedConnectorIds: ['connector-a'],
  installedAt: '2026-08-18T00:00:00.000Z',
  ...overrides
})

describe('MarketplaceRepository', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'marketplace-repo-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('returns an empty document for a missing file', async () => {
    const repository = new MarketplaceRepository(dir)
    const document = await repository.getAll()
    expect(document).toEqual({
      version: 1,
      sources: [],
      installations: [],
      pendingInstallations: [],
      rootCaches: [],
      releaseCaches: []
    })
  })

  it('round-trips sources, installations, and caches through the JSON file', async () => {
    const repository = new MarketplaceRepository(dir)
    const source = makeSource()
    await repository.addSource(source)
    await repository.recordInstallation(makeProvenance())
    await repository.cacheRoot(
      source.id,
      Uint8Array.from([1, 2, 3]),
      Uint8Array.from([4, 5]),
      '2026-08-18T00:00:00.000Z'
    )

    const reloaded = new MarketplaceRepository(dir)
    const document = await reloaded.getAll()
    expect(document.sources).toEqual([source])
    expect(document.installations).toHaveLength(1)
    const cached = await reloaded.getCachedRoot(source.id)
    expect(cached?.cachedAt).toBe('2026-08-18T00:00:00.000Z')
    expect(Array.from(cached?.rootBytes ?? [])).toEqual([1, 2, 3])
    expect(Array.from(cached?.signatureBytes ?? [])).toEqual([4, 5])
  })

  it('drops corrupted entries during sanitize instead of failing the whole document', async () => {
    const repository = new MarketplaceRepository(dir)
    await repository.addSource(makeSource())
    await repository.recordInstallation(makeProvenance())

    // Corrupt the file: turn the source's fingerprint into an invalid value.
    const filePath = join(dir, 'specialist-marketplace.json')
    const raw = await readFile(filePath, 'utf8')
    const tampered = raw.replace('a'.repeat(64), 'not-a-fingerprint')
    await import('node:fs/promises').then(({ writeFile }) =>
      writeFile(filePath, tampered, 'utf8')
    )

    const reloaded = new MarketplaceRepository(dir)
    const document = await reloaded.getAll()
    expect(document.sources).toEqual([])
    // Installations survive (they were intact).
    expect(document.installations).toHaveLength(1)
  })

  it('dedupes sources by id on add and filters caches on remove', async () => {
    const repository = new MarketplaceRepository(dir)
    const source = makeSource()
    await repository.addSource(source)
    await repository.addSource({ ...source, name: 'Updated Name' })
    let document = await repository.getAll()
    expect(document.sources).toHaveLength(1)
    expect(document.sources[0]?.name).toBe('Updated Name')

    await repository.cacheRoot(source.id, Uint8Array.from([9]), Uint8Array.from([8]), 't')
    await repository.removeSource(source.id)
    document = await repository.getAll()
    expect(document.sources).toEqual([])
    expect(document.rootCaches).toEqual([])
  })

  it('queues mutations so concurrent writes never interleave', async () => {
    const repository = new MarketplaceRepository(dir)
    await Promise.all([
      repository.addSource(makeSource({ id: 'source-a' })),
      repository.addSource(makeSource({ id: 'source-b' })),
      repository.addSource(makeSource({ id: 'source-c' }))
    ])
    const document = await repository.getAll()
    expect(document.sources.map((source) => source.id).sort()).toEqual([
      'source-a',
      'source-b',
      'source-c'
    ])
  })
})

describe('marketplace protocol', () => {
  it('parses a valid root document', () => {
    const bytes = new TextEncoder().encode(
      JSON.stringify({
        schema_version: 1,
        revision: '2026-08-18',
        marketplace: { id: 'test-marketplace', name: 'Test Marketplace' },
        specialists: [
          {
            id: 'example-specialist',
            display_name: 'Example Specialist',
            summary: 'A test specialist.',
            publisher: { id: 'example', name: 'Example' },
            latest: {
              version: '1.0.0',
              release: { path: 'releases/specialist-1.0.0.json', sha256: 'f'.repeat(64) }
            }
          }
        ]
      })
    )
    const root = parseMarketplaceRoot(bytes)
    expect(root.marketplace.id).toBe('test-marketplace')
    expect(root.specialists[0]?.latest.version).toBe('1.0.0')
  })

  it('rejects a root with a dangerous release path', () => {
    const bytes = new TextEncoder().encode(
      JSON.stringify({
        schema_version: 1,
        revision: 'r',
        marketplace: { id: 'm', name: 'M' },
        specialists: [
          {
            id: 's',
            display_name: 'S',
            summary: 's',
            publisher: { id: 'p', name: 'P' },
            latest: { version: '1.0.0', release: { path: '../escape.json', sha256: 'f'.repeat(64) } }
          }
        ]
      })
    )
    expect(() => parseMarketplaceRoot(bytes)).toThrow()
  })

  it('parses a release document with skills and connectors', () => {
    const bytes = new TextEncoder().encode(
      JSON.stringify({
        schema_version: 1,
        specialist_id: 'example-specialist',
        version: '1.0.0',
        source: {
          repository: 'https://github.com/example/marketplace',
          commit: 'e'.repeat(40),
          license: 'MIT'
        },
        artifact: {
          path: 'artifacts/specialist-1.0.0.zip',
          github_release: { tag: 'v1.0.0', asset_name: 'specialist-1.0.0.zip' },
          sha256: 'c'.repeat(64),
          compressed_bytes: 100,
          uncompressed_bytes: 200,
          file_count: 3
        },
        defaults: { skill_ids: ['skill-a'], connector_ids: ['connector-a'] },
        skills: [
          {
            id: 'skill-a',
            name: 'skill-a',
            display_name: 'Skill A',
            description: 'A skill.',
            path: 'skills/skill-a/SKILL.md',
            content_digest: 'd'.repeat(64),
            file_count: 2,
            uncompressed_bytes: 50
          }
        ],
        connectors: [{ id: 'connector-a', required: true, default_selected: true }]
      })
    )
    const release = parseMarketplaceRelease(bytes)
    expect(release.skills[0]?.id).toBe('skill-a')
    expect(release.connectors[0]?.required).toBe(true)
  })

  it('computes sha256 and key fingerprints', () => {
    expect(sha256(new Uint8Array())).toHaveLength(64)
    expect(marketplaceKeyFingerprint('MCowBQYDK2VwAyEA8Jt1UypmPMFX0N8u8QJdJzRkmEwX2b0kK0v6Qy6iN4Q=')).toHaveLength(64)
  })

  it('rejects a signature whose key does not verify the root', () => {
    const rootBytes = new TextEncoder().encode(JSON.stringify({ hello: 'world' }))
    const signature = {
      schema_version: 1,
      algorithm: 'ed25519',
      key_id: 'key',
      public_key: 'MCowBQYDK2VwAyEA8Jt1UypmPMFX0N8u8QJdJzRkmEwX2b0kK0v6Qy6iN4Q=',
      signature: 'bm90LWEtcmVhbC1zaWduYXR1cmU='
    } as const
    expect(verifyMarketplaceRoot(rootBytes, signature)).toBe(false)
  })

  it('parses a valid signature envelope', () => {
    const bytes = new TextEncoder().encode(
      JSON.stringify({
        schema_version: 1,
        algorithm: 'ed25519',
        key_id: 'test-key',
        public_key: 'MCowBQYDK2VwAyEA8Jt1UypmPMFX0N8u8QJdJzRkmEwX2b0kK0v6Qy6iN4Q=',
        signature: 'c2lnbmF0dXJl'
      })
    )
    const signature = parseMarketplaceSignature(bytes)
    expect(signature.key_id).toBe('test-key')
    expect(signature.algorithm).toBe('ed25519')
  })

  it('rejects malformed signatures and non-utf8 input', () => {
    const bad = new TextEncoder().encode(JSON.stringify({ schema_version: 1, algorithm: 'rsa' }))
    expect(() => parseMarketplaceSignature(bad)).toThrow()
    // Invalid UTF-8 must fail the fatal decoder, not produce replacement characters.
    expect(() => parseMarketplaceRoot(Uint8Array.from([0xff, 0xfe, 0xfd]))).toThrow()
  })
})

describe('MarketplaceService official-source fail-closed', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'marketplace-service-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('lists an empty but usable marketplace when the official source has no trusted key', async () => {
    // OFFICIAL_MARKETPLACE_SOURCE.trustedKeys is intentionally empty until a release exists.
    // The service must OMIT the official source (not throw) so the marketplace stays usable
    // for user-approved GitHub sources.
    const repository = new MarketplaceRepository(dir)
    const service = new MarketplaceService({
      repository,
      packages: {
        preview: vi.fn(),
        install: vi.fn(),
        candidateNewSkillIds: vi.fn(),
        cancel: vi.fn(),
        dispose: vi.fn()
      },
      fetch: vi.fn(),
      officialSource: OFFICIAL_MARKETPLACE_SOURCE,
      getDisabledSkillIds: async () => [],
      getInstalledSpecialists: async () => [],
      setSkillsMainEnabled: async () => {}
    })
    const snapshot = await service.list()
    expect(snapshot.sources).toEqual([])
    expect(snapshot.specialists).toEqual([])
    expect(snapshot.failures).toEqual([])
  })
})
