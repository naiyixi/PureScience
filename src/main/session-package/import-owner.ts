import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { PersistedChatMessage, PersistedChatSession } from '../../shared/session-persistence'
import {
  SESSION_PACKAGE_IMPORT_RECORD_SUFFIX,
  type SessionPackageImportRecord
} from '../../shared/session-package-import'
import type { ImportedSessionDraft, SessionPackageImportDeps } from './import-session'

export type SessionPackageImportOwnerDeps = {
  /** Where session documents live: `<configRoot>/sessions/<projectId>/<sessionId>.json`. */
  configRoot: string
  /** The app's own persistence for a session document. */
  saveSession: (session: PersistedChatSession) => Promise<void>
  /** Absolute workspace directory for the new session id (the app's convention). */
  workspaceFor: (sessionId: string) => string
  now?: () => Date
}

export const importRecordPath = (
  configRoot: string,
  projectId: string,
  sessionId: string
): string =>
  join(configRoot, 'sessions', projectId, `${sessionId}${SESSION_PACKAGE_IMPORT_RECORD_SUFFIX}`)

/** An imported session is one that has a record beside it. Absence is the normal case. */
export const readSessionPackageImportRecord = async (
  configRoot: string,
  projectId: string,
  sessionId: string
): Promise<SessionPackageImportRecord | undefined> => {
  try {
    const raw = await readFile(importRecordPath(configRoot, projectId, sessionId), 'utf8')
    return JSON.parse(raw) as SessionPackageImportRecord
  } catch {
    return undefined
  }
}

const messagesOf = (conversation: unknown): PersistedChatMessage[] => {
  const messages = (conversation as { messages?: unknown } | undefined)?.messages
  return Array.isArray(messages) ? (messages as PersistedChatMessage[]) : []
}

/**
 * The app-side half of the import: build a real session document from the draft, then write the record
 * that makes it readable-but-not-runnable. The record is written SECOND on purpose — a session without
 * its record is a normal session, whereas a record without its session would point at nothing.
 */
export const createSessionPackageImportOwner = (
  deps: SessionPackageImportOwnerDeps
): {
  saveImportedSession: (draft: ImportedSessionDraft) => Promise<void>
  ports: (readPackage: (path: string) => Promise<Uint8Array>) => SessionPackageImportDeps
} => {
  const saveImportedSession = async (draft: ImportedSessionDraft): Promise<void> => {
    const session: PersistedChatSession = {
      id: draft.sessionId,
      projectId: draft.projectId,
      title: draft.title,
      cwd: deps.workspaceFor(draft.sessionId),
      // An imported session is not running and must not appear to be.
      status: 'idle',
      // Required on the document, not decoration: the conversation graph this session materializes
      // takes its frame and branch timestamps from here, and a graph without them is dropped by the
      // app's own validator — which quarantined every imported session as invalid.
      createdAt: draft.createdAt,
      updatedAt: draft.updatedAt,
      messages: messagesOf(draft.conversation)
    }

    await deps.saveSession(session)

    const recordPath = importRecordPath(deps.configRoot, draft.projectId, draft.sessionId)
    const temporary = `${recordPath}.partial`
    try {
      await mkdir(dirname(recordPath), { recursive: true })
      await writeFile(temporary, `${JSON.stringify(draft.record, null, 2)}\n`, 'utf8')
      await rename(temporary, recordPath)
    } catch (error) {
      await rm(temporary, { force: true }).catch((): void => {})
      throw error
    }
  }

  /** The two ports `importSessionPackage` wants, bound to this app's storage. */
  const ports = (readPackage: (path: string) => Promise<Uint8Array>): SessionPackageImportDeps => ({
    readPackage,
    saveImportedSession,
    now: deps.now
  })

  return Object.freeze({ saveImportedSession, ports })
}

export type SessionPackageImportOwner = ReturnType<typeof createSessionPackageImportOwner>
