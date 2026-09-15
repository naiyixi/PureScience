import { randomUUID } from 'node:crypto'

import { strFromU8, unzipSync } from 'fflate'

import {
  SESSION_PACKAGE_IMPORT_POSTURE,
  type SessionPackageImportRecord,
  type SessionPackageImportRequest,
  type SessionPackageImportResult
} from '../../shared/session-package-import'
import { inspectSessionPackage } from './import'

// A draft, not a PersistedChatSession: the app owns how a session document is shaped, and an imported
// one must not smuggle in fields the importer invented.
export type ImportedSessionDraft = {
  sessionId: string
  projectId: string
  title: string
  /** The package's conversation, verbatim. */
  conversation: unknown
  /** The record that keeps the session readable but never runnable. */
  record: SessionPackageImportRecord
}

export type SessionPackageImportDeps = {
  readPackage: (path: string) => Promise<Uint8Array>
  saveImportedSession: (draft: ImportedSessionDraft) => Promise<void>
  now?: () => Date
  newId?: () => string
}

/**
 * Land a package as a new, read-only session. Nothing is written until the caller confirms, and the
 * session gets a fresh identity: the package's own ids are kept only as provenance.
 */
export const importSessionPackage = async (
  deps: SessionPackageImportDeps,
  request: SessionPackageImportRequest
): Promise<SessionPackageImportResult> => {
  // A preview never writes; the import must be asked for explicitly.
  if (!request.confirm) return { ok: false, reason: 'not-confirmed' }
  const targetProjectId = request.confirm.targetProjectId
  if (!targetProjectId) return { ok: false, reason: 'no-target-project' }

  let bytes: Uint8Array
  try {
    bytes = await deps.readPackage(request.packagePath)
  } catch {
    return { ok: false, reason: 'not-a-package' }
  }

  const preview = inspectSessionPackage(bytes)
  if (!preview.accepted || !preview.described) {
    return { ok: false, reason: preview.reason ?? 'not-a-package' }
  }

  const described = preview.described
  // The archive was inspected above (safe paths, bounded sizes, required evidence present).
  const conversationEntry = unzipSync(bytes)['conversation.json']
  let conversation: unknown
  try {
    conversation = JSON.parse(strFromU8(conversationEntry))
  } catch {
    return { ok: false, reason: 'manifest-invalid' }
  }

  const sessionId = (deps.newId ?? randomUUID)()
  const record: SessionPackageImportRecord = {
    importedAt: (deps.now?.() ?? new Date()).toISOString(),
    importedFrom: {
      sessionId: described.session.id,
      projectId: described.session.projectId,
      appVersion: described.appVersion,
      exportedAt: described.exportedAt
    },
    posture: SESSION_PACKAGE_IMPORT_POSTURE,
    assertion: described.assertion,
    notes: described.notes
  }

  try {
    await deps.saveImportedSession({
      sessionId,
      projectId: targetProjectId,
      title: described.session.title,
      conversation,
      record
    })
  } catch {
    return { ok: false, reason: 'write-failed' }
  }

  return { ok: true, sessionId, posture: SESSION_PACKAGE_IMPORT_POSTURE, notes: described.notes }
}
