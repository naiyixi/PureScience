import {
  createArtifactVersionLocator,
  type ArtifactLineageProvenance
} from '../../../../shared/artifact-provenance'

// What a bookmark must name before it is written: one Artifact Version the artifacts API can resolve.
//
// The reason this exists at all is a defect the real-window acceptance found. A preview built from a
// transcript card can carry an artifact id and version id that the artifact store has never seen — the
// page renders, the ids look plausible, and a pointer written from them resolves to nothing, so the
// reader's saved passage opens an empty preview and no error anywhere. Measured on the packaged app, the
// session document held the identity the store knows (artifactId be0d8e88…, versionId ba03752d…) while
// the card carried a different pair with no lineage at all.
//
// So the identity is confirmed, not assumed: the preview's own pair is accepted only when the store
// agrees, the session document is asked next, and when neither resolves the caller stores nothing.

export type BookmarkVersionIdentity = {
  artifactId: string
  versionId: string
  locator: string
}

export type BookmarkVersionIdentityInput = {
  projectId: string
  sessionId: string
  /** Identity the preview carries. Trusted only after the store confirms it. */
  artifactId?: string
  versionId?: string
  /** File name, used to find the same file's real identity in the session document. */
  name: string
}

const hasVersion = (lineage: ArtifactLineageProvenance | undefined, versionId: string): boolean =>
  (lineage?.versions ?? []).some((version) => version.versionId === versionId)

export const resolveBookmarkVersionIdentity = async (
  input: BookmarkVersionIdentityInput
): Promise<BookmarkVersionIdentity | undefined> => {
  const api = window.api
  const build = (artifactId: string, versionId: string): BookmarkVersionIdentity => ({
    artifactId,
    versionId,
    locator: createArtifactVersionLocator({
      projectId: input.projectId,
      appSessionId: input.sessionId,
      artifactId,
      versionId
    })
  })

  if (input.artifactId && input.versionId) {
    const lineage = await api.artifacts.getLineage({
      projectId: input.projectId,
      appSessionId: input.sessionId,
      artifactId: input.artifactId
    })
    if (hasVersion(lineage, input.versionId)) return build(input.artifactId, input.versionId)
  }

  // The document is where the artifact the reader is looking at is recorded under the identity the store
  // actually uses, so it is the fallback that makes a preview taken from a transcript card bookmarkable.
  const document = await api.sessions.readDocument({
    projectId: input.projectId,
    sessionId: input.sessionId
  })
  const entry = (document?.artifacts ?? []).find(
    (artifact) =>
      artifact.name === input.name && Boolean(artifact.artifactId) && Boolean(artifact.versionId)
  )
  if (!entry?.artifactId || !entry.versionId) return undefined

  const lineage = await api.artifacts.getLineage({
    projectId: input.projectId,
    appSessionId: input.sessionId,
    artifactId: entry.artifactId
  })
  if (!hasVersion(lineage, entry.versionId)) return undefined
  return build(entry.artifactId, entry.versionId)
}
