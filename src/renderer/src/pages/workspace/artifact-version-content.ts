import type { PreviewFileSource } from '@/stores/preview-workbench-store'

import { createPreviewRequestScope, getPreviewFileReader } from './previews/preview-file-reader'

// Full-text read budget for the edit/compare surfaces. One preview page matches the main-process
// hard cap (10 MB); the total budget bounds the in-memory accumulation for very large artifacts.
export const ARTIFACT_FULL_TEXT_PAGE_BYTES = 10 * 1024 * 1024
export const ARTIFACT_FULL_TEXT_MAX_BYTES = 20 * 1024 * 1024

export class ArtifactContentTooLargeError extends Error {
  readonly sizeBytes: number

  constructor(sizeBytes: number) {
    super(
      `Artifact content is ${sizeBytes} bytes; the full-text limit is ${ARTIFACT_FULL_TEXT_MAX_BYTES} bytes.`
    )
    this.name = 'ArtifactContentTooLargeError'
    this.sizeBytes = sizeBytes
  }
}

export type ArtifactFullTextScope = {
  projectId?: string
  sessionId?: string
  path: string
  source?: PreviewFileSource
}

// Reads one managed file/version end-to-end. Preview pages are contiguous byte windows (UTF-8-safe
// boundaries), so concatenating every page reproduces the exact stored text. Fails closed above the
// total budget rather than silently truncating what the user would then re-save.
export const readArtifactFullText = async ({
  projectId,
  sessionId,
  path,
  source = 'artifact'
}: ArtifactFullTextScope): Promise<string> => {
  const reader = getPreviewFileReader(source)
  const scope = createPreviewRequestScope({ projectId, sessionId, source, path })
  const pages: string[] = []
  let offset = 0
  let sizeBytes: number | undefined

  for (let pageIndex = 0; pageIndex < 10_000; pageIndex += 1) {
    const page = await reader({
      ...scope,
      path,
      encoding: 'utf8',
      maxBytes: ARTIFACT_FULL_TEXT_PAGE_BYTES,
      offset
    })
    if (sizeBytes === undefined) {
      sizeBytes = page.size
      if (page.size > ARTIFACT_FULL_TEXT_MAX_BYTES) {
        throw new ArtifactContentTooLargeError(page.size)
      }
    }
    pages.push(page.content)
    if (page.truncated && page.nextOffset !== undefined) {
      offset = page.nextOffset
      continue
    }
    return pages.join('')
  }

  throw new Error('Artifact full-text read did not converge within the page limit.')
}

// Compact timestamp for version pickers (locale-aware; falls back to the raw value on bad input).
export const formatVersionTimestamp = (createdAt?: string): string => {
  if (!createdAt) return ''
  const time = Date.parse(createdAt)
  if (!Number.isFinite(time)) return createdAt
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(time)
}
