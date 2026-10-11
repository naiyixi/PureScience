// Renderer-safe copies of storage types whose canonical definitions live in main-only modules
// (src/main/storage/*), mirroring how ArtifactFile/NotebookRunSummary are shared with preload.

export type UsageCategoryKey = 'artifacts' | 'uploads' | 'runtime' | 'notebooks' | 'workspaces'
export type SharedBytes = { bytes: number; files: number }
export type UsageChild = { name: string; bytes: number }
export type UsageCategory = { key: UsageCategoryKey; bytes: number; children?: UsageChild[] }
export type StorageUsage = {
  categories: UsageCategory[]
  totalBytes: number
  // What sharing saved, measured in the same walk: a file whose inode was already counted contributes
  // nothing to `totalBytes`, and this is the size it would otherwise have added. Absent means the walk did
  // not track it (older payloads) — never "nothing was saved".
  sharedBytes?: number
  sharedFiles?: number
  // True when these numbers are a placeholder while the first walk of the root is still running. Reading usage
  // is a full disk walk (measured 13.7 s on a real 7 GB root), so a cold cache answers with this instead of
  // blocking the caller for the length of the walk. Callers must render it as "still measuring" — never as a
  // zero-byte total, which would read as "my data is gone".
  pending?: boolean
}

// P0-10: what an on-demand duplicate sweep did. `bytes` is the total size of the names that were
// replaced by a hard link to an identical copy already on disk — the same bytes the panel's own walk
// moves out of `totalBytes` and into `sharedBytes`, so the reading and the action can be checked
// against each other instead of believed. Every field is a count taken from the filesystem walk.
export type DuplicateSweepResult = {
  /** Same-size candidates whose bytes were hashed to decide whether they were duplicates. */
  scanned: number
  /** Names replaced by a link to a verified identical copy. */
  linked: number
  /** Bytes reclaimed by those replacements (the replaced file's own size). */
  bytes: number
  /** Distinct contents found among the hashed candidates. */
  distinct: number
  /** Files already sharing their bytes with another name, left alone. */
  alreadyShared: number
  /** Candidates whose bytes could not be read, so nothing is claimed about them. */
  unreadable: number
  /** Verified duplicates whose replacement failed (e.g. cross-device); left exactly as they were. */
  unlinked: number
  elapsedMs: number
  // P0-10: the same on-demand action also reclaims the SHARED PACKAGE CACHE names whose bytes another
  // link still holds (the cache only ever grew before this). Counts from what was actually removed; a
  // last-link cache file is never touched, and its size is reported as left alone.
  cacheFreedBytes?: number
  cacheFreedFiles?: number
  cacheLeftAloneBytes?: number
}

// A user-triggered maintenance call reports failure as data rather than as a bare rejection, so the
// panel can say what went wrong instead of showing nothing.
export type DuplicateSweepOutcome =
  | ({ ok: true } & DuplicateSweepResult)
  | { ok: false; error: string }

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
  /**
   * Present when the picked folder carries a migration marker: a copy that was staged but never
   * committed, possibly by a previous process. 'verified' can still be committed; 'copying' is an
   * incomplete copy and can only be discarded. The folder stays `kind: 'invalid'` either way — it is
   * not usable as a data root as it stands — so no existing consumer can mistake it for adoptable.
   */
  unfinishedMove?: { status: 'copying' | 'verified' }
}
