import { describe, expect, it } from 'vitest'

import { extractArtifacts } from './extract-artifacts'

// The session document is the source: message-level `artifactIds` are already persisted, so the bundle
// needs no second repository (and no projectName) to name what this session produced.

describe('extractArtifacts', () => {
  it('collects artifact ids across messages, in first-seen order', () => {
    const artifacts = extractArtifacts({
      messages: [
        { id: 'm1', artifactIds: ['v1', 'v2'] },
        { id: 'm2', content: 'no artifacts' },
        { id: 'm3', artifactIds: ['v2', 'v3'] }
      ]
    })

    expect(artifacts.map((artifact) => artifact.artifactVersionId)).toEqual(['v1', 'v2', 'v3'])
  })

  it('writes only the locator it actually has', () => {
    const [artifact] = extractArtifacts({ messages: [{ artifactIds: ['v1'] }] })

    // No checksum or runId exists in the document, so none is invented.
    expect(artifact).toEqual({ artifactVersionId: 'v1' })
  })

  it('ignores blank, non-string and missing ids', () => {
    expect(
      extractArtifacts({
        messages: [{ artifactIds: ['  ', '', 42, null, 'v1'] }, { artifactIds: 'not-an-array' }]
      }).map((artifact) => artifact.artifactVersionId)
    ).toEqual(['v1'])
  })

  it('returns nothing for a session without messages', () => {
    expect(extractArtifacts({})).toEqual([])
    expect(extractArtifacts(undefined)).toEqual([])
    expect(extractArtifacts({ messages: [] })).toEqual([])
  })
})
