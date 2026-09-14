import { describe, expect, it, vi } from 'vitest'

import type { ArtifactPreviewResult } from '../../shared/artifacts'
import { GLOBAL_SEARCH_MAX_FILE_TEXT_BYTES, isSearchableTextFile } from '../../shared/global-search'
import { createSearchFileTextReader, type SearchFileTextItem } from './file-text-reader'

const item = (overrides: Partial<SearchFileTextItem> = {}): SearchFileTextItem => ({
  projectId: 'project-a',
  sessionId: 'session-a',
  name: 'deg.csv',
  path: 'out/deg.csv',
  source: 'artifact',
  ...overrides
})

const preview = (content: string, encoding: 'utf8' | 'base64' = 'utf8'): ArtifactPreviewResult => ({
  content,
  encoding,
  size: content.length,
  truncated: false
})

const harness = (
  overrides: { item?: SearchFileTextItem | undefined } = {}
): {
  read: (fileId: string) => Promise<string | undefined>
  readArtifactPreview: ReturnType<typeof vi.fn>
  readUploadPreview: ReturnType<typeof vi.fn>
} => {
  const readArtifactPreview = vi.fn(async () => preview('artifact text'))
  const readUploadPreview = vi.fn(async () => preview('upload text'))
  const findItem = vi.fn(() => ('item' in overrides ? overrides.item : item()))

  return {
    read: createSearchFileTextReader({ findItem, readArtifactPreview, readUploadPreview }),
    readArtifactPreview,
    readUploadPreview
  }
}

describe('isSearchableTextFile', () => {
  it('accepts text-like extensions, case-insensitively', () => {
    expect(isSearchableTextFile('deg.csv')).toBe(true)
    expect(isSearchableTextFile('NOTES.MD')).toBe(true)
    expect(isSearchableTextFile('analysis.ipynb')).toBe(true)
  })

  it('refuses binary files and names without a usable extension', () => {
    expect(isSearchableTextFile('figure.png')).toBe(false)
    expect(isSearchableTextFile('paper.pdf')).toBe(false)
    expect(isSearchableTextFile('archive.tar.gz')).toBe(false)
    expect(isSearchableTextFile('LICENSE')).toBe(false)
    expect(isSearchableTextFile('.gitignore')).toBe(false)
    expect(isSearchableTextFile('trailing.')).toBe(false)
  })
})

describe('createSearchFileTextReader', () => {
  it('reads an artifact file with a bounded, text-only request', async () => {
    const { read, readArtifactPreview, readUploadPreview } = harness()

    await expect(read('file-1')).resolves.toBe('artifact text')
    expect(readUploadPreview).not.toHaveBeenCalled()
    expect(readArtifactPreview).toHaveBeenCalledWith({
      path: 'out/deg.csv',
      projectId: 'project-a',
      sessionId: 'session-a',
      maxBytes: GLOBAL_SEARCH_MAX_FILE_TEXT_BYTES,
      encoding: 'utf8'
    })
  })

  it('reads an upload through the upload reader', async () => {
    const { read, readArtifactPreview, readUploadPreview } = harness({
      item: item({ source: 'upload', name: 'notes.md', path: 'notes.md' })
    })

    await expect(read('file-2')).resolves.toBe('upload text')
    expect(readArtifactPreview).not.toHaveBeenCalled()
    expect(readUploadPreview).toHaveBeenCalledOnce()
  })

  it('does not read a binary file at all', async () => {
    const { read, readArtifactPreview } = harness({
      item: item({ name: 'figure.png' })
    })

    await expect(read('file-3')).resolves.toBeUndefined()
    expect(readArtifactPreview).not.toHaveBeenCalled()
  })

  it('returns nothing for an unknown file rather than a made-up read', async () => {
    const { read, readArtifactPreview } = harness({ item: undefined })

    await expect(read('file-missing')).resolves.toBeUndefined()
    expect(readArtifactPreview).not.toHaveBeenCalled()
  })

  it('treats a base64 payload as unsearchable, not as text', async () => {
    const readArtifactPreview = vi.fn(async () => preview('AAAA', 'base64'))
    const read = createSearchFileTextReader({
      findItem: () => item(),
      readArtifactPreview,
      readUploadPreview: vi.fn()
    })

    await expect(read('file-4')).resolves.toBeUndefined()
  })

  it('returns nothing when the read fails, so a failure never reads as "not in the file"', async () => {
    const readArtifactPreview = vi.fn(async () => {
      throw new Error('file gone')
    })
    const read = createSearchFileTextReader({
      findItem: () => item(),
      readArtifactPreview,
      readUploadPreview: vi.fn()
    })

    await expect(read('file-5')).resolves.toBeUndefined()
  })
})
