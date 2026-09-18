export type ProjectFileSource = 'artifact' | 'upload'

export type ProjectFileOriginSession = {
  state: 'active' | 'deleting' | 'deleted'
  title?: string
  deletedAt?: string
}

// Renderer-facing metadata projection. File bytes remain on disk and are read lazily through the
// existing source-specific preview IPC only after this DTO has been paged into the Files view.
export type ProjectFileItem = {
  id: string
  source: ProjectFileSource
  sourceFileId: string
  sourceVersionId?: string
  checksum?: string
  projectId: string
  sessionId: string
  messageId?: string
  name: string
  path: string
  mimeType?: string
  size: number
  mtimeMs?: number
  sortAtMs: number
  originSession?: ProjectFileOriginSession
}

export type ProjectFilesSearch = {
  // Filename substring search is ASCII case-insensitive; non-ASCII characters match literally.
  filenameContains: string
  // Active workspace surfaces exclude archived Sessions at query time so counts and cursors match
  // the visible Files catalog. Archive management continues to query without this filter.
  excludedSessionIds?: string[]
}

export type GetProjectFilesOverviewRequest = {
  projectId: string
  search?: ProjectFilesSearch
}

export type ListProjectFilesRequest = {
  projectId: string
  // Uploads and each session's artifacts are deliberately separate collections with independent
  // cursors for the Files page. The flat `all` collection is reserved for cross-session file pickers
  // that need one canonical Project Files read model rather than reconstructing Session metadata.
  collection:
    { kind: 'all' } | { kind: 'uploads' } | { kind: 'sessionArtifacts'; sessionId: string }
  search?: ProjectFilesSearch
  cursor?: string
  limit: number
  // The Files page renders a file's origin (which Session produced it); the Home page's per-project chips
  // derive an extension from the name and nothing else. Those chips read every visible project at once, and
  // each read cost two engine round-trips — the page query and the origin query — so the fan-out paid for
  // origin data nobody rendered. Skipping it halves the queries that queue in front of everything else.
  omitOrigins?: boolean
}

// One round-trip for many projects: the Home page needs a file-type chip per project, and one read per project
// put that many queries in front of everything else in the same engine queue. Kinds are derived in main from
// the newest files of each project, using the same rule the renderer used (shared/project-file-kinds).
export type ListProjectFileKindsRequest = {
  projectIds: string[]
}

export type ProjectFileKindsSummary = {
  projectId: string
  kinds: string[]
}

export type ProjectFilesPage = {
  items: ProjectFileItem[]
  nextCursor?: string
  totalCount: number
}

// Bounded global-search projection. The primary Project is independently paged; Other Projects
// deliberately return only a small combined sample so the command palette remains responsive.
export type SearchArtifactsRequest = {
  primaryProjectId: string
  otherProjectIds: string[]
  filenameContains?: string
  excludedSessionIds?: string[]
  primaryLimit: number
  primaryCursor?: string
  otherLimit: 0 | 1 | 2 | 3 | 4 | 5
}

export type SearchArtifactsResult = {
  primary: ProjectFilesPage
  other: ProjectFileItem[]
  isIndexComplete: boolean
}

export type ListArtifactGroupsRequest = {
  projectId: string
  search?: ProjectFilesSearch
  cursor?: string
  limit: number
}

export type ArtifactGroupItem = {
  sessionId: string
  artifactCount: number
  originSession?: ProjectFileOriginSession
}

export type ArtifactGroupPage = {
  items: ArtifactGroupItem[]
  nextCursor?: string
  totalCount: number
}

export type ProjectFilesOverview = {
  totalCount: number
  uploadCount: number
  artifactCount: number
  artifactGroupCount: number
  // False means the current rows are usable but may be partial; the renderer must expose repair
  // rather than treating a zero count as an authoritative empty project.
  isIndexComplete: boolean
}

// Main-process invalidation event. A missing sessionId or reset kind invalidates every cursor layer;
// a scoped event lets the renderer reload only uploads or one artifact session plus group metadata.
export type ProjectFilesChangedEvent = {
  projectId: string
  sessionId?: string
  sources: ProjectFileSource[]
  kind: 'upsert' | 'delete' | 'reset'
}
