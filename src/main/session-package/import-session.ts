import { randomUUID } from 'node:crypto'

import { strFromU8 } from 'fflate'

import {
  SESSION_PACKAGE_IMPORT_POSTURE,
  SESSION_PACKAGE_LIMITS,
  type SessionPackageImportRecord,
  type SessionPackageImportRequest,
  type SessionPackageImportResult
} from '../../shared/session-package-import'
import { inspectSessionPackage } from './import'
import { readZipEntries } from './zip-reader'

// A draft, not a PersistedChatSession: the app owns how a session document is shaped, and an imported
// one must not smuggle in fields the importer invented.
export type ImportedSessionDraft = {
  sessionId: string
  projectId: string
  title: string
  /** The package's conversation, verbatim. */
  conversation: unknown
  /**
   * Container timestamps for the document the app is about to write. Taken from the packaged
   * conversation when it carries them (newer packages do), else stamped at import time: a session
   * document with no timestamps materializes a conversation graph whose frames carry none, and the
   * app's own session-file validator then drops those frames and quarantines the whole session.
   */
  createdAt: number
  updatedAt: number
  /** The record that keeps the session readable but never runnable. */
  record: SessionPackageImportRecord
}

// A package's conversation slice is `{ messages, artifacts, createdAt?, updatedAt? }` today and was
// `{ messages, artifacts }` for packages exported before the timestamps travelled — so both shapes are
// accepted, and an older one is stamped at import time rather than given a made-up history.
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const asTimestamp = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined

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
  // The archive was inspected above (safe paths, bounded sizes, required evidence present). Only the one
  // member that is needed is expanded, under the same ceilings — never the whole package at once.
  const read = readZipEntries(bytes, SESSION_PACKAGE_LIMITS, { only: ['conversation.json'] })
  if (!read.ok) return { ok: false, reason: 'not-a-package' }
  const conversationEntry = read.entries.get('conversation.json')
  if (!conversationEntry) return { ok: false, reason: 'required-evidence-missing' }
  let conversation: unknown
  try {
    conversation = JSON.parse(strFromU8(conversationEntry))
  } catch {
    return { ok: false, reason: 'manifest-invalid' }
  }

  const sessionId = (deps.newId ?? randomUUID)()
  const now = deps.now?.() ?? new Date()
  const carried = isRecord(conversation) ? conversation : {}
  const createdAt = asTimestamp(carried.createdAt) ?? now.getTime()
  const updatedAt = asTimestamp(carried.updatedAt) ?? createdAt
  const record: SessionPackageImportRecord = {
    importedAt: now.toISOString(),
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
      createdAt,
      updatedAt,
      record
    })
  } catch {
    return { ok: false, reason: 'write-failed' }
  }

  return { ok: true, sessionId, posture: SESSION_PACKAGE_IMPORT_POSTURE, notes: described.notes }
}
