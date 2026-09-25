// Renderer-safe copies of storage types whose canonical definitions live in main-only modules
// (src/main/storage/*), mirroring how ArtifactFile/NotebookRunSummary are shared with preload.

export type UsageCategoryKey = 'artifacts' | 'uploads' | 'runtime' | 'notebooks' | 'workspaces'
export type UsageChild = { name: string; bytes: number }
export type UsageCategory = { key: UsageCategoryKey; bytes: number; children?: UsageChild[] }
export type StorageUsage = {
  categories: UsageCategory[]
  totalBytes: number
  // True when these numbers are a placeholder while the first walk of the root is still running. Reading usage
  // is a full disk walk (measured 13.7 s on a real 7 GB root), so a cold cache answers with this instead of
  // blocking the caller for the length of the walk. Callers must render it as "still measuring" — never as a
  // zero-byte total, which would read as "my data is gone".
  pending?: boolean
}

export type StorageInfo = {
  dataRoot: string
  isDefault: boolean
  // The default data root and the parent that reproduces it. `defaultParent` is fed to the same
  // inspect/migrate flow a browsed folder would be; `defaultDataRoot` is the derived destination
  // shown to the user in Settings' one-click "return to default" affordance (accurate there because
  // the affordance only appears when the current root is custom, i.e. the default is <home>/PureScience).
  defaultDataRoot: string
  defaultParent: string
  // True only when settings.dataRoot is explicitly configured but the resolved directory is gone
  // (deleted, or an unmounted external/network drive). False for a fresh install whose default
  // `~/PureScience` simply hasn't been created yet.
  dataRootMissing: boolean
  // True when this is a pre-§20 legacy install whose data still lives in the hidden config root and
  // the user hasn't yet answered the one-time "move it into the visible PureScience folder" prompt.
  // Drives the first-run LegacyDataMoveDialog; once answered (moved/relocated/declined) it stays false.
  legacyDataMovePrompt: boolean
  usage: StorageUsage
  availableBytes: number
}

export type RevealAppStorageResult = {
  revealed: boolean
  error?: string
}

export type ActiveSessionInfo = {
  // The owning project's id (the artifact/notebook storage key). main doesn't hold the human
  // project name or session title — the renderer maps this id + sessionId to display strings.
  projectId: string
  sessionId: string
  kind: 'agent' | 'notebook'
  title?: string
}

export type MigrationPhase = 'scan' | 'copy' | 'verify' | 'delete'
export type MigrationProgress = {
  phase: MigrationPhase
  copiedBytes: number
  totalBytes: number
  currentPath?: string
}
export type MigrationResult =
  | { ok: true; staleEvidence?: StaleProvenanceEvidence[] }
  | { ok: false; error: string; cancelled?: boolean }
// Mirrors main's StaleProvenanceEvidence (src/main/storage/provenance-migration-validation.ts): evidence
// from an older build that is intact but no longer validates. Reported to the user, never fatal.
export type StaleProvenanceEvidence = {
  kind: 'manifest-name-mismatch' | 'manifest-checksum-mismatch'
  path: string
  recordedDigest: string
  expectedDigest: string
  runId?: string
  project?: string
  session?: string
}

export type MigrationOutcome =
  MigrationResult | { ok: false; error: string; switchoverFailed: true }

// Result of validating (or applying) a candidate data root, mirroring main's ValidateResult
// (src/main/storage/migration-service.ts) without importing main-only code into the renderer.
export type DataRootValidationResult = { ok: true } | { ok: false; error: string }

// Classification of a candidate data root, mirroring main's ClassifyResult
// (src/main/storage/migration-service.ts). 'move' = empty writable target (copy-in migration).
// 'adopt' = already contains our data (pointer switch only, no move). 'invalid' carries a reason.
// `dataRoot` is the derived `<parent>/PureScience` path, always present so the caller can display
// the final location regardless of kind.
export type DataRootKind = 'move' | 'adopt' | 'invalid'
export type DataRootInspection = {
  kind: DataRootKind
  dataRoot: string
  error?: string
}
