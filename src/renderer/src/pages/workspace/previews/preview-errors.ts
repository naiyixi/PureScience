// Short tag for an unavailable file, shown on file cards/thumbnails so the state is perceivable at
// a glance. Both "missing" and "outside storage" share the same tag; only the opened view differs.
// The tag is a dictionary key, not a word: the badge sits on file tiles that are otherwise translated,
// so an English "Missing" was the only untranslated thing on a Chinese tile. (The two long sentences
// that used to live here were removed — nothing consumed them; the opened view reads
// `ws.fileUnavailable` / `ws.previewUnavailable` through the renderer's own t.)
export const FILE_MISSING_TAG_KEY = 'preview.missingTag' as const

// True when a read failed because the underlying file is missing on disk. Electron IPC drops custom
// error props (e.g. `code`), so across the boundary the fs message ("ENOENT: no such file…") is the
// reliable signal; the `code` check still covers same-process callers and tests.
export const isMissingFileError = (error: unknown): boolean => {
  if (!error) return false
  if ((error as { code?: unknown }).code === 'ENOENT') return true
  const message = error instanceof Error ? error.message : String(error)
  return /ENOENT|no such file|no longer (exists|available)/i.test(message)
}

// True when a read was rejected because the path resolves outside the managed storage root — the
// main process throws "… is outside … storage." for both uploads and artifacts. This is a sandbox
// boundary rejection (stale / cross-root path), distinct from a missing file.
export const isOutsideStorageError = (error: unknown): boolean => {
  if (!error) return false
  const message = error instanceof Error ? error.message : String(error)
  return /outside\s+\S+\s+storage/i.test(message)
}

// True when a file can't be shown because it's unavailable under the current storage root — either
// missing (deleted/moved) or outside it. Used to badge tiles and to quiet expected read failures.
export const isUnavailableFileError = (error: unknown): boolean =>
  isMissingFileError(error) || isOutsideStorageError(error)
