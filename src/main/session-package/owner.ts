import type { PersistedChatSession } from '../../shared/session-persistence'
import {
  SESSION_PACKAGE_EXTENSION,
  type ExportSessionPackageRequest,
  type ExportSessionPackageResult
} from '../../shared/session-package'
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
  /**
   * Where this session's files come from. The app records them in a catalog keyed by session (NOT in the
   * session document — reading the document finds nothing), so the caller that owns that catalog
   * supplies both the count and the bytes.
   */
  files: {
    countFiles: (request: { projectId: string; sessionId: string }) => Promise<number>
    listFiles: (request: {
      projectId: string
      sessionId: string
    }) => Promise<{ files: readonly SessionPackageFile[]; unreadable: readonly string[] }>
  }
  /**
   * The project's reference-library PDFs. Optional: without it the package carries the citations and
   * says nothing about PDFs, which is the behaviour every existing caller already has.
   */
  referenceFiles?: {
    countReferenceFiles: (request: { projectId: string }) => Promise<number>
    listReferenceFiles: (request: {
      projectId: string
    }) => Promise<{ files: readonly SessionPackageFile[]; unreadable: readonly string[] }>
  }
  appVersion: string
  /** Native save dialog (desktop only). Absent where no dialog can exist, which refuses the export. */
  showSaveDialog?: (suggestedFileName: string) => Promise<string | null>
  now?: () => Date
  maxFileBytes?: number
}

// The request and result shapes are the wire contract, so they live in shared/session-package.ts.

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

export const createSessionPackageOwner = (
  deps: SessionPackageOwnerDeps
): {
  exportPackage: (
    request: ExportSessionPackageRequest,
    // A per-call dialog: the desktop adapter knows which window invoked it, and that window owns the
    // sheet. Falls back to the one on the deps, then to a named refusal.
    options?: { showSaveDialog?: (suggestedFileName: string) => Promise<string | null> }
  ) => Promise<ExportSessionPackageResult>
} => {
  const exportPackage = async (
    request: ExportSessionPackageRequest,
    options?: { showSaveDialog?: (suggestedFileName: string) => Promise<string | null> }
  ): Promise<ExportSessionPackageResult> => {
    const loaded = await deps.loadSession(request.projectId, request.sessionId)
    if (loaded.status !== 'found') {
      return {
        ok: false,
        error: loaded.status === 'missing' ? 'session-not-found' : 'session-unreadable'
      }
    }

    const maxFileBytes = deps.maxFileBytes ?? DEFAULT_SESSION_PACKAGE_MAX_FILE_BYTES

    let destination = request.destinationPath
    if (!destination) {
      const showSaveDialog = options?.showSaveDialog ?? deps.showSaveDialog
      if (!showSaveDialog) return { ok: false, error: 'no-destination' }
      destination = (await showSaveDialog(packageFileName(loaded.session.title))) ?? undefined
      if (!destination) return { ok: false, error: 'cancelled' }
    }

    const fileRequest = { projectId: request.projectId, sessionId: request.sessionId }
    const ports: SessionPackagePorts = {
      loadSession: deps.loadSession,
      listReviews: (sessionId) => deps.listReviews(sessionId),
      listEvidence: async (sessionId) => {
        const reviews = await deps.listReviews(sessionId)
        return deps.listEvidence(reviews.map((review) => review.id))
      },
      listCitations: () => deps.listReferences(request.projectId),
      // Counting is free; reading is not. Essential packages name how many files they left behind.
      countFiles: () => deps.files.countFiles(fileRequest),
      listFiles: () => deps.files.listFiles(fileRequest),
      ...(deps.referenceFiles
        ? {
            countReferenceFiles: (request: { projectId: string }) =>
              deps.referenceFiles!.countReferenceFiles(request),
            listReferenceFiles: (request: { projectId: string }) =>
              deps.referenceFiles!.listReferenceFiles(request)
          }
        : {}),
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
