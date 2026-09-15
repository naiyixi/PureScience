import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { PersistedChatSession } from '../../shared/session-persistence'
import type { SessionPackageManifest, SessionPackageMode } from '../../shared/session-package'
import { createSessionPackage, type SessionPackageFile } from './export'

// Everything the exporter needs from the rest of the app. Ports rather than direct imports so the
// wiring step can point them at the real stores and the tests can drive real files without a database.
export type SessionPackagePorts = {
  loadSession: (
    projectId: string,
    sessionId: string
  ) => Promise<
    | { status: 'found'; session: PersistedChatSession }
    | { status: 'missing' }
    | { status: 'unreadable' }
  >
  /** Review records for the session, exactly as the reviewer store holds them. */
  listReviews: (sessionId: string) => Promise<readonly unknown[]>
  /** Human-pinned evidence rows for the session. */
  listEvidence: (sessionId: string) => Promise<readonly unknown[]>
  /** Citations captured for the session (GB/T text travels inside them). */
  listCitations: (sessionId: string) => Promise<readonly unknown[]>
  /** The session's files, already read into bytes, under `files/…` package paths. */
  listFiles: (request: {
    projectId: string
    sessionId: string
  }) => Promise<readonly SessionPackageFile[]>
  /**
   * How many files the session has, without reading them. An essential package omits the files but must
   * still tell its reader how many stayed behind.
   */
  countFiles?: (request: { projectId: string; sessionId: string }) => Promise<number>
  readEnvironment?: (request: {
    projectId: string
    sessionId: string
  }) => Promise<unknown | undefined>
  readReproductionOutputs?: (request: {
    projectId: string
    sessionId: string
  }) => Promise<readonly SessionPackageFile[]>
  appVersion: string
  now?: () => Date
}

export type ExportSessionPackageRequest = {
  projectId: string
  sessionId: string
  mode: SessionPackageMode
  destinationPath: string
  maxFileBytes?: number
}

// Named refusals, never prose: the renderer decides how to phrase them in the reader's language.
export type SessionPackageFailure = 'session-not-found' | 'session-unreadable' | 'write-failed'

export type ExportSessionPackageResult =
  | { ok: true; path: string; bytes: number; manifest: SessionPackageManifest }
  | { ok: false; error: SessionPackageFailure }

export const exportSessionPackage = async (
  ports: SessionPackagePorts,
  request: ExportSessionPackageRequest
): Promise<ExportSessionPackageResult> => {
  const loaded = await ports.loadSession(request.projectId, request.sessionId)
  if (loaded.status === 'missing') return { ok: false, error: 'session-not-found' }
  if (loaded.status === 'unreadable') return { ok: false, error: 'session-unreadable' }

  const [citations, reviews, evidence] = await Promise.all([
    ports.listCitations(request.sessionId),
    ports.listReviews(request.sessionId),
    ports.listEvidence(request.sessionId)
  ])

  const full = request.mode === 'full'
  const files = full
    ? await ports.listFiles({ projectId: request.projectId, sessionId: request.sessionId })
    : []
  const filesNotRequested = full
    ? undefined
    : await ports.countFiles?.({ projectId: request.projectId, sessionId: request.sessionId })
  const environment = full
    ? await ports.readEnvironment?.({ projectId: request.projectId, sessionId: request.sessionId })
    : undefined
  const reproductionOutputs = full
    ? ((await ports.readReproductionOutputs?.({
        projectId: request.projectId,
        sessionId: request.sessionId
      })) ?? [])
    : []

  const { archive, manifest } = createSessionPackage(
    {
      session: {
        id: loaded.session.id,
        title: loaded.session.title,
        projectId: loaded.session.projectId
      },
      appVersion: ports.appVersion,
      exportedAt: (ports.now?.() ?? new Date()).toISOString(),
      conversation: {
        messages: loaded.session.messages,
        artifacts: loaded.session.artifacts ?? []
      },
      citations,
      reviewFindings: reviews,
      verificationRecords: evidence,
      files,
      filesNotRequested,
      environment,
      reproductionOutputs,
      maxFileBytes: request.maxFileBytes
    },
    request.mode
  )

  // Write beside the destination and rename: a reader never finds a half-written package, and a failed
  // export leaves no `.science` claiming to be complete.
  const temporary = `${request.destinationPath}.partial`
  try {
    await mkdir(dirname(request.destinationPath), { recursive: true })
    await writeFile(temporary, archive)
    await rename(temporary, request.destinationPath)
  } catch {
    // Best-effort cleanup: a failing cleanup must never replace the named refusal the caller needs.
    await rm(temporary, { force: true }).catch(() => {})
    return { ok: false, error: 'write-failed' }
  }

  return { ok: true, path: request.destinationPath, bytes: archive.byteLength, manifest }
}
