// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resolveBookmarkVersionIdentity } from './bookmark-version-identity'

// The defect this pins, found on the packaged app: a preview built from a transcript card can carry an
// artifact id and version id the artifacts store has never seen. Accepting them would store a bookmark
// whose pointer resolves to nothing — a saved passage that opens an empty preview.

const lineage = (
  versions: string[]
): { artifactId: string; versions: Array<{ versionId: string }> } => ({
  artifactId: 'artifact',
  versions: versions.map((versionId) => ({ versionId }))
})

const stubApi = (options: {
  lineages: Record<string, string[] | undefined>
  documentArtifacts?: Array<Record<string, unknown>>
}): void => {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      artifacts: {
        getLineage: vi.fn(async ({ artifactId }: { artifactId: string }) => {
          const versions = options.lineages[artifactId]
          return versions ? lineage(versions) : undefined
        })
      },
      sessions: {
        readDocument: vi.fn(async () => ({ artifacts: options.documentArtifacts ?? [] }))
      }
    }
  })
}

const previous = (window as unknown as { api?: unknown }).api

beforeEach(() => {
  vi.restoreAllMocks()
})

afterEach(() => {
  // jsdom's own `window.api` (when a previous test file defined it) is not writable, so it is restored
  // the same way it was replaced.
  Object.defineProperty(window, 'api', { configurable: true, writable: true, value: previous })
})

describe('resolveBookmarkVersionIdentity', () => {
  it('uses the identity the preview carries when the store confirms it', async () => {
    stubApi({ lineages: { 'artifact-known': ['version-known'] } })
    const resolved = await resolveBookmarkVersionIdentity({
      projectId: 'project-1',
      sessionId: 'session-1',
      artifactId: 'artifact-known',
      versionId: 'version-known',
      name: 'figure.pdf'
    })
    expect(resolved?.artifactId).toBe('artifact-known')
    expect(resolved?.versionId).toBe('version-known')
    expect(resolved?.locator).toContain('version-known')
  })

  // The measured case: the card's pair has no lineage, while the session document records the identity
  // the store does know. The pointer must be built from the one that resolves.
  it('falls back to the session document when the preview identity is unknown to the store', async () => {
    stubApi({
      lineages: { 'artifact-real': ['version-real'] },
      documentArtifacts: [
        { name: 'figure.pdf', artifactId: 'artifact-real', versionId: 'version-real' }
      ]
    })
    const resolved = await resolveBookmarkVersionIdentity({
      projectId: 'project-1',
      sessionId: 'session-1',
      artifactId: 'artifact-synthesized',
      versionId: 'version-synthesized',
      name: 'figure.pdf'
    })
    expect(resolved?.artifactId).toBe('artifact-real')
    expect(resolved?.versionId).toBe('version-real')
    expect(resolved?.locator).toContain('version-real')
  })

  it('stores nothing when neither identity resolves', async () => {
    stubApi({
      lineages: {},
      documentArtifacts: [
        { name: 'other.pdf', artifactId: 'artifact-other', versionId: 'version-other' }
      ]
    })
    await expect(
      resolveBookmarkVersionIdentity({
        projectId: 'project-1',
        sessionId: 'session-1',
        artifactId: 'artifact-synthesized',
        versionId: 'version-synthesized',
        name: 'figure.pdf'
      })
    ).resolves.toBeUndefined()
  })

  // A document entry whose version is gone must not be trusted either: it would point at nothing.
  it('stores nothing when the document names a version the artifact no longer has', async () => {
    stubApi({
      lineages: { 'artifact-real': ['version-other'] },
      documentArtifacts: [
        { name: 'figure.pdf', artifactId: 'artifact-real', versionId: 'version-real' }
      ]
    })
    await expect(
      resolveBookmarkVersionIdentity({
        projectId: 'project-1',
        sessionId: 'session-1',
        name: 'figure.pdf'
      })
    ).resolves.toBeUndefined()
  })
})
