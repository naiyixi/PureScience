// User-linked folder grants: a researcher grants the agent read access to an entire local
// directory via `@path/to/folder`. The app owns the grant (rootId ↔ absolute path), persists it
// across sessions, and only ever hands the agent relative paths resolved against granted roots —
// never arbitrary renderer-provided absolute paths. Revoking a root immediately breaks resolution.

export type FolderGrant = Readonly<{
  rootId: string
  // Absolute path of the granted directory.
  rootPath: string
  // User-facing label (usually the directory name).
  label: string
  createdAt: number
}>

export type FolderGrantRequest = Readonly<{ path: string }>
export type FolderGrantRevokeRequest = Readonly<{ rootId: string }>

export type FolderGrantsSnapshot = Readonly<{
  grants: readonly FolderGrant[]
}>

// IPC channel names.
export const FOLDER_GRANTS_CHANNEL_LIST = 'folder-grants:list'
export const FOLDER_GRANTS_CHANNEL_GRANT = 'folder-grants:grant'
export const FOLDER_GRANTS_CHANNEL_REVOKE = 'folder-grants:revoke'

export const FOLDER_GRANTS_MAX = 16
export const FOLDER_GRANTS_MAX_PATH_LENGTH = 4096
