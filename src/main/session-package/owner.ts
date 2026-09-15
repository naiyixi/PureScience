import { basename } from 'node:path'

import type { ArtifactPreviewResult } from '../../shared/artifacts'
import type { PersistedChatSession } from '../../shared/session-persistence'
import { SESSION_PACKAGE_EXTENSION, type SessionPackageMode } from '../../shared/session-package'
import { DEFAULT_SESSION_PACKAGE_MAX_FILE_BYTES, type SessionPackageFile } from './export'
import { exportSessionPackage, type SessionPackagePorts } from './service'

// Everything the exporter needs from the rest of the app, injected so the wiring stays testable and the
// native dialog stays at the edge.
export type SessionPackageOwnerDeps = {
  loadSession: (
    projectId: string,
    sessionId: string
  ) => Promise<
    | { status: 'found'; session: PersistedChatSession }
    | { status: 'missing' }
    | { status: 'unreadable' }
  >
  listReviews: (sessionId: string) => Promise<readonly { id: string }[]>
  /** Human-pinned evidence rows, asked for by the reviews they belong to. */
  listEvidence: (reviewIds: readonly string[]) => Promise<readonly unknown[]>
  /** The project's reference library — the citations a session cites travel inside it. */
  listReferences: (projectId: string) => Promise<readonly unknown[]>
  /** Bounded read of one artifact. A truncated preview is refused by the caller, never shipped. */
  readArtifact: (request: {
    path: string
    projectId: string
    sessionId: string
    maxBytes: number
  }) => Promise<ArtifactPreviewResult>
  appVersion: string
  /** Native save dialog (desktop only). Absent where no dialog can exist, which refuses the export. */
  showSaveDialog?: (suggestedFileName: string) => Promise<string | null>
  now?: () => Date
  maxFileBytes?: number
}

export type ExportPackageRequest = {
  projectId: string
  sessionId: string
  mode: SessionPackageMode
  destinationPath?: string
}

export type ExportPackageFailure =
  'cancelled' | 'session-not-found' | 'session-unreadable' | 'no-destination' | 'write-failed'

export type ExportPackageResult =
  | { ok: true; path: string; bytes: number; notes: readonly string[] }
  | { ok: false; error: ExportPackageFailure }

// Titles come from prompts and can hold anything a path cannot; the package name must not decide
// whether the export works.
const packageFileName = (title: string): string => {
  const stem = title
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
  return `${stem || 'session'}${SESSION_PACKAGE_EXTENSION}`
}

const toBytes = (preview: ArtifactPreviewResult): Uint8Array =>
  preview.encoding === 'base64'
    ? new Uint8Array(Buffer.from(preview.content, 'base64'))
    : new TextEncoder().encode(preview.content)

export const createSessionPackageOwner = (
  deps: SessionPackageOwnerDeps
): { exportPackage: (request: ExportPackageRequest) => Promise<ExportPackageResult> } => {
  const exportPackage = async (request: ExportPackageRequest): Promise<ExportPackageResult> => {
    const loaded = await deps.loadSession(request.projectId, request.sessionId)
    if (loaded.status !== 'found') {
      return {
        ok: false,
        error: loaded.status === 'missing' ? 'session-not-found' : 'session-unreadable'
      }
    }

    const artifacts = loaded.session.artifacts ?? []
    const maxFileBytes = deps.maxFileBytes ?? DEFAULT_SESSION_PACKAGE_MAX_FILE_BYTES

    let destination = request.destinationPath
    if (!destination) {
      if (!deps.showSaveDialog) return { ok: false, error: 'no-destination' }
      destination = (await deps.showSaveDialog(packageFileName(loaded.session.title))) ?? undefined
      if (!destination) return { ok: false, error: 'cancelled' }
    }

    const ports: SessionPackagePorts = {
      loadSession: deps.loadSession,
      listReviews: (sessionId) => deps.listReviews(sessionId),
      listEvidence: async (sessionId) => {
        const reviews = await deps.listReviews(sessionId)
        return deps.listEvidence(reviews.map((review) => review.id))
      },
      listCitations: () => deps.listReferences(request.projectId),
      // Counting is free; reading is not. Essential packages name how many files they left behind.
      countFiles: async () => artifacts.length,
      listFiles: async () => {
        const files: SessionPackageFile[] = []
        const unreadable: string[] = []
        for (const artifact of artifacts) {
          const packagePath = `files/${artifact.name ?? basename(artifact.path)}`
          try {
            const preview = await deps.readArtifact({
              path: artifact.path,
              projectId: request.projectId,
              sessionId: request.sessionId,
              maxBytes: maxFileBytes
            })
            if (preview.truncated) {
              // A bounded preview is not the file. Shipping the head as the whole artifact would be a
              // quiet lie, so the file is named as unread instead.
              unreadable.push(packagePath)
              continue
            }
            files.push({ path: packagePath, contents: toBytes(preview) })
          } catch {
            unreadable.push(packagePath)
          }
        }
        return { files, unreadable }
      },
      appVersion: deps.appVersion,
      now: deps.now
    }

    const result = await exportSessionPackage(ports, {
      projectId: request.projectId,
      sessionId: request.sessionId,
      mode: request.mode,
      destinationPath: destination,
      maxFileBytes
    })
    if (!result.ok) return { ok: false, error: result.error }

    return {
      ok: true,
      path: result.path,
      bytes: result.bytes,
      notes: result.manifest.notes
    }
  }

  return Object.freeze({ exportPackage })
}

export type SessionPackageOwner = ReturnType<typeof createSessionPackageOwner>
