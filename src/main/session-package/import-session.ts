import { randomUUID } from 'node:crypto'

import { strFromU8 } from 'fflate'

import {
  SESSION_PACKAGE_IMPORT_POSTURE,
  SESSION_PACKAGE_LIMITS,
  type SessionPackageEvidenceKind,
  type SessionPackageEvidenceLanding,
  type SessionPackageEvidenceSkip,
  type SessionPackageImportRecord,
  type SessionPackageImportRequest,
  type SessionPackageImportResult
} from '../../shared/session-package-import'
import { REQUIRED_PACKAGE_EVIDENCE, inspectSessionPackage } from './import'
import type { ImportedEvidenceInput } from './import-evidence'
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
  /**
   * Hand the package's citations, review findings and verification records to this machine's stores.
   * Called AFTER the session document is written: a pin is re-derived from the transcript, so the
   * session has to exist first. Absent stores are not an excuse to drop the evidence — the port is
   * required, and a store that cannot take a row says so through the landing report.
   */
  landEvidence: (input: ImportedEvidenceInput) => Promise<SessionPackageEvidenceLanding>
  now?: () => Date
  newId?: () => string
}

// Every evidence member is read from JSON the sender produced: an unreadable one is refused rather
// than imported with the missing half silently dropped.
const readEvidenceList = (
  entries: ReadonlyMap<string, Uint8Array>,
  path: string
): { ok: true; rows: readonly unknown[] } | { ok: false } => {
  const bytes = entries.get(path)
  if (!bytes) return { ok: false }
  try {
    const parsed: unknown = JSON.parse(strFromU8(bytes))
    return Array.isArray(parsed) ? { ok: true, rows: parsed } : { ok: false }
  } catch {
    return { ok: false }
  }
}

const messageIdsOf = (conversation: unknown): string[] => {
  const messages = (conversation as { messages?: unknown } | undefined)?.messages
  if (!Array.isArray(messages)) return []
  return messages.flatMap((message): string[] => {
    const id = (message as { id?: unknown } | undefined)?.id
    return typeof id === 'string' && id !== '' ? [id] : []
  })
}

// Names every carried row as not landed, for the case where the landing port itself threw.
const landingFailure = (
  rows: readonly unknown[],
  kind: SessionPackageEvidenceKind
): SessionPackageEvidenceSkip[] =>
  rows.map((row) => {
    const record = (row ?? {}) as Record<string, unknown>
    const id = kind === 'citations' ? record.citationKey : record.id
    return typeof id === 'string' && id !== ''
      ? { kind, reason: 'landing-failed', id }
      : { kind, reason: 'landing-failed' }
  })

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
  // The archive was inspected above (safe paths, bounded sizes, required evidence present). Only the
  // members that are needed are expanded, under the same ceilings — never the whole package at once.
  const read = readZipEntries(bytes, SESSION_PACKAGE_LIMITS, {
    only: [...REQUIRED_PACKAGE_EVIDENCE]
  })
  if (!read.ok) return { ok: false, reason: 'not-a-package' }
  const conversationEntry = read.entries.get('conversation.json')
  if (!conversationEntry) return { ok: false, reason: 'required-evidence-missing' }
  let conversation: unknown
  try {
    conversation = JSON.parse(strFromU8(conversationEntry))
  } catch {
    return { ok: false, reason: 'manifest-invalid' }
  }
  const citations = readEvidenceList(read.entries, 'evidence/citations.json')
  const reviewFindings = readEvidenceList(read.entries, 'evidence/review-findings.json')
  const verificationRecords = readEvidenceList(read.entries, 'evidence/verifications.json')
  if (!citations.ok || !reviewFindings.ok || !verificationRecords.ok) {
    // The package claims evidence it cannot produce as a list. Refusing here is the honest answer:
    // importing half of it would hand the reader a session missing rows it was told it had.
    return { ok: false, reason: 'evidence-unreadable' }
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

  // The evidence lands after the session document, because a pin's fingerprint is re-derived from the
  // transcript this machine now holds. A landing never fails the import: the session is written, and
  // every row that did not land is named in the report instead of being reported as if it had.
  const landed = await deps
    .landEvidence({
      targetProjectId,
      sessionId,
      messageIds: messageIdsOf(conversation),
      citations: citations.rows,
      reviewFindings: reviewFindings.rows,
      verificationRecords: verificationRecords.rows
    })
    // The landing module reports its own refusals; this guard only covers a port that threw anyway.
    // Nothing is swallowed: every row the package carried is named as not landed.
    .catch((): SessionPackageEvidenceLanding => ({
      citations: 0,
      reviews: 0,
      reviewFindings: 0,
      verificationRecords: 0,
      skipped: [
        ...landingFailure(citations.rows, 'citations'),
        ...landingFailure(reviewFindings.rows, 'review-findings'),
        ...landingFailure(verificationRecords.rows, 'verifications')
      ]
    }))

  return {
    ok: true,
    sessionId,
    posture: SESSION_PACKAGE_IMPORT_POSTURE,
    notes: described.notes,
    landed
  }
}
