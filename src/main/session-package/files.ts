import type { ArtifactPreviewResult } from '../../shared/artifacts'
import type { SessionPackageFile } from './export'

// Everything the listing needs, injected: this module owns the *policy* (what travels, what is named as
// unread) and the app owns the storage.
export type SessionPackageFilesDeps = {
  /**
   * The project's file catalog. Entries carry the session they belong to, so a session's files are the
   * project list filtered by session — no per-message fan-out and no second source of truth.
   */
  listProjectFiles: (request: {
    projectName: string
  }) => Promise<readonly { name?: string; path: string; sessionId?: string }[]>
  /** A bounded read. `truncated` must be honoured: a head is not the file. */
  readPreview: (request: {
    path: string
    projectId: string
    sessionId: string
    maxBytes: number
  }) => Promise<ArtifactPreviewResult>
  /** Maximum bytes a single carried file may have. */
  maxFileBytes: number
}

const toBytes = (preview: ArtifactPreviewResult): Uint8Array =>
  preview.encoding === 'base64'
    ? new Uint8Array(Buffer.from(preview.content, 'base64'))
    : new TextEncoder().encode(preview.content)

const baseName = (path: string): string => path.split('/').filter(Boolean).at(-1) ?? path

// Two messages can produce files with the same name. They must not overwrite each other in the archive,
// and they must not be silently dropped either: later duplicates get a stable `~2`, `~3` suffix.
export const uniquePackagePath = (usedNames: Set<string>, name: string): string => {
  const stem = name.replace(/[/\\]/g, '_')
  if (!usedNames.has(stem)) {
    usedNames.add(stem)
    return stem
  }
  let index = 2
  while (usedNames.has(`${stem}~${index}`)) index += 1
  const unique = `${stem}~${index}`
  usedNames.add(unique)
  return unique
}

export type SessionPackageFileListerApi = {
  countFiles: (request: { projectId: string; sessionId: string }) => Promise<number>
  listFiles: (request: {
    projectId: string
    sessionId: string
  }) => Promise<{ files: SessionPackageFile[]; unreadable: string[] }>
  describe: (request: { projectId: string; sessionId: string }) => Promise<{
    status: 'found' | 'unreadable'
    files: SessionPackageFile[]
    unreadable: string[]
    total: number
  }>
}

export const createSessionPackageFileLister = (
  deps: SessionPackageFilesDeps
): SessionPackageFileListerApi => {
  const collect = async (
    projectId: string,
    sessionId: string
  ): Promise<
    { status: 'found'; candidates: { name?: string; path: string }[] } | { status: 'unreadable' }
  > => {
    const all = await deps.listProjectFiles({ projectName: projectId }).catch(() => undefined)
    if (!all) return { status: 'unreadable' }
    return {
      status: 'found',
      candidates: all.filter((entry): boolean => entry.sessionId === sessionId)
    }
  }

  const countFiles = async (request: { projectId: string; sessionId: string }): Promise<number> => {
    const collected = await collect(request.projectId, request.sessionId)
    return collected.status === 'found' ? collected.candidates.length : 0
  }

  const listFiles = async (request: {
    projectId: string
    sessionId: string
  }): Promise<{ files: SessionPackageFile[]; unreadable: string[] }> => {
    const collected = await collect(request.projectId, request.sessionId)
    if (collected.status !== 'found') return { files: [], unreadable: [] }

    const usedNames = new Set<string>()
    const files: SessionPackageFile[] = []
    const unreadable: string[] = []

    for (const candidate of collected.candidates) {
      const name = uniquePackagePath(usedNames, candidate.name ?? baseName(candidate.path))
      const packagePath = `files/${name}`
      try {
        const preview = await deps.readPreview({
          path: candidate.path,
          projectId: request.projectId,
          sessionId: request.sessionId,
          maxBytes: deps.maxFileBytes
        })
        if (preview.truncated) {
          // A bounded preview is the head of a file, not the file. Carrying it would be a quiet lie.
          unreadable.push(packagePath)
          continue
        }
        files.push({ path: packagePath, contents: toBytes(preview) })
      } catch {
        unreadable.push(packagePath)
      }
    }

    return { files, unreadable }
  }

  /** Everything the export needs to describe what it did and did not carry. */
  const describe = async (request: {
    projectId: string
    sessionId: string
  }): Promise<{
    status: 'found' | 'unreadable'
    files: SessionPackageFile[]
    unreadable: string[]
    total: number
  }> => {
    const collected = await collect(request.projectId, request.sessionId)
    if (collected.status !== 'found') {
      return { status: collected.status, files: [], unreadable: [], total: 0 }
    }
    const { files, unreadable } = await listFiles(request)
    return { status: 'found', files, unreadable, total: collected.candidates.length }
  }

  return Object.freeze({ countFiles, listFiles, describe })
}

export type SessionPackageFileLister = ReturnType<typeof createSessionPackageFileLister>
