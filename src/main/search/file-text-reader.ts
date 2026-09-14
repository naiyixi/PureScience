// Reads a project file's text for a search.
//
// Bounded on purpose: at most `GLOBAL_SEARCH_MAX_FILE_TEXT_BYTES` are read, only text-like extensions
// are read at all, and a read that fails returns undefined — because "could not be read" must never be
// reported as "this text is not in the file".

import { GLOBAL_SEARCH_MAX_FILE_TEXT_BYTES, isSearchableTextFile } from '../../shared/global-search'
import type { ArtifactPreviewResult, ReadArtifactPreviewRequest } from '../../shared/artifacts'

export type SearchFileTextItem = {
  projectId: string
  sessionId: string
  name: string
  path: string
  source: 'artifact' | 'upload'
}

export type SearchFileTextReaderDeps = {
  findItem(fileId: string): SearchFileTextItem | undefined
  readArtifactPreview(request: ReadArtifactPreviewRequest): Promise<ArtifactPreviewResult>
  readUploadPreview(request: ReadArtifactPreviewRequest): Promise<ArtifactPreviewResult>
}

export const createSearchFileTextReader = (
  deps: SearchFileTextReaderDeps
): ((fileId: string) => Promise<string | undefined>) => {
  return async (fileId) => {
    const item = deps.findItem(fileId)
    if (!item || !isSearchableTextFile(item.name)) return undefined

    const request: ReadArtifactPreviewRequest = {
      path: item.path,
      projectId: item.projectId,
      sessionId: item.sessionId,
      maxBytes: GLOBAL_SEARCH_MAX_FILE_TEXT_BYTES,
      encoding: 'utf8'
    }

    try {
      const preview =
        item.source === 'upload'
          ? await deps.readUploadPreview(request)
          : await deps.readArtifactPreview(request)

      // Only decoded text can be matched; a base64 payload is not searchable text.
      return preview.encoding === 'utf8' ? preview.content : undefined
    } catch {
      return undefined
    }
  }
}
