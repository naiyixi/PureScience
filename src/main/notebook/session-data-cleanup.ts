// Releasing a deleted project's notebook session data (v2.0.0 P0-10③).
//
// Real evidence, 2026-10-11: deleting a project removes its sessions, reviews, provenance and content-store
// blobs, but NOTHING removed `<dataRoot>/notebooks/<projectId>` — the cleanup vocabulary in
// `projects/deletion-coordinator.ts` never names it. Measured on the real data root: 37 such directories
// holding 3.7 GB, and a single one held 1.1 GB of real analysis output (three 300 MB .h5ad files from one
// single-cell run). So the defect is not "this data should be cleaned up automatically" — it is a user's
// results, and the user chose to delete the project that owns them. The defect is that the deletion did not
// do what it said: the bytes stayed on disk.
//
// Removal therefore reports the bytes it actually freed, refuses an id that could escape the notebooks
// directory, and treats "not there" as a named state rather than as zero bytes freed. The same applies to
// the other direction: a removal whose bytes could NOT be read (a directory that exists but cannot be
// listed) states that too, because a 0 that nobody measured would read at the surface as "nothing there".

import { rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

import type {
  SessionNotebookDataDeletion,
  SessionNotebookUsage
} from '../../shared/session-persistence'
import { measureDirectorySize, type DirectorySizeMeasurement } from '../storage/usage'

export type ProjectNotebookDataCleanupResult = {
  /** Bytes the removal actually freed; 0 for 'absent'/'refused' — and for 'removed' with no reading below. */
  freedBytes: number
  state: 'removed' | 'absent' | 'refused'
  /**
   * Present only when the directory WAS removed but could not be read first (`measureDirectorySize`'s word
   * for that). `freedBytes` is then 0 because nobody measured it, not because there was nothing there —
   * absence of this field is what makes 0 a reading an empty directory really produced.
   */
  freedBytesState?: 'unreadable'
}

// The session-level receipt is the wire shape the renderer renders, so this module returns that exact
// type rather than a local twin that could drift from it.
export type SessionNotebookDataCleanupResult = SessionNotebookDataDeletion

type CleanupLogger = {
  info: (message: string, metadata: Record<string, unknown>) => void
}

export type ProjectNotebookDataCleanupOptions = {
  dataRoot: string
  log?: CleanupLogger
}

// The session-level removal takes the same inputs; the project and session ids are separate arguments.
export type SessionNotebookDataCleanupOptions = ProjectNotebookDataCleanupOptions

// A project id is an opaque cuid and a session id is a uuid. Anything with a separator, a parent
// reference, or an unexpected shape is refused by name: these functions delete directories recursively,
// so every segment they join is a path-traversal boundary.
const SAFE_ID_SEGMENT = /^[A-Za-z0-9_-]{1,64}$/

// The log line carries the same distinction the receipt does: a figure that was measured, or the named
// state saying there is no figure. Both cleanup levels go through this one helper so the two lines cannot
// drift into reporting the state differently.
const describeNotebookBytes = (
  measurement: DirectorySizeMeasurement
): { freedBytes: number; freedBytesState?: 'unreadable' } =>
  measurement.state === 'measured'
    ? { freedBytes: measurement.bytes }
    : { freedBytes: 0, freedBytesState: measurement.reason }

export const deleteProjectNotebookData = async (
  options: ProjectNotebookDataCleanupOptions,
  projectId: string
): Promise<ProjectNotebookDataCleanupResult> => {
  if (!SAFE_ID_SEGMENT.test(projectId)) {
    options.log?.info('project notebook data refused', { reason: 'unsafe-project-id' })
    return { freedBytes: 0, state: 'refused' }
  }

  const root = join(options.dataRoot, 'notebooks', projectId)
  try {
    const info = await stat(root)
    if (!info.isDirectory()) {
      // Named, not silent: "this project had no notebook data" and "the removal quietly did not happen"
      // must not look the same in a log — the second one is the failure this whole path exists to avoid.
      options.log?.info('project notebook data absent', { projectId })
      return { freedBytes: 0, state: 'absent' }
    }
  } catch {
    options.log?.info('project notebook data absent', { projectId })
    return { freedBytes: 0, state: 'absent' }
  }

  // Measured before the removal: afterwards the number would have to be remembered rather than read.
  // Three-state on purpose (P0-10's second half): a directory that exists but cannot be listed has no
  // reading, so folding it into `freedBytes: 0` would put a figure in the receipt that nobody measured.
  const measurement = await measureDirectorySize(root, new Set())
  await rm(root, { recursive: true, force: true })
  options.log?.info('project notebook data removed', {
    projectId,
    ...describeNotebookBytes(measurement)
  })
  return {
    freedBytes: measurement.state === 'measured' ? measurement.bytes : 0,
    state: 'removed',
    ...(measurement.state === 'unavailable' ? { freedBytesState: measurement.reason } : {})
  }
}

// What one session's own run data occupies on disk, read BEFORE the session is deleted.
//
// Why this exists separately from the removal above: the confirmation that precedes a session delete says
// what else goes with it, and it can only say that honestly with a reading. Same path minting and the same
// id boundary as the removal (one source for both), and the same three states as every other optional
// reading in this file — a number, "there is no such directory", or "cannot be read". A surface that prints
// nothing for the last one is making the "nothing to lose" claim on our behalf.
export const measureSessionNotebookData = async (
  options: ProjectNotebookDataCleanupOptions,
  projectId: string,
  sessionId: string
): Promise<SessionNotebookUsage> => {
  if (!SAFE_ID_SEGMENT.test(projectId)) {
    options.log?.info('session notebook data not measured', { reason: 'unsafe-project-id' })
    return { state: 'unavailable', reason: 'unsafe-id' }
  }
  if (!SAFE_ID_SEGMENT.test(sessionId)) {
    options.log?.info('session notebook data not measured', { reason: 'unsafe-session-id' })
    return { state: 'unavailable', reason: 'unsafe-id' }
  }

  const root = join(options.dataRoot, 'notebooks', projectId, sessionId)
  try {
    const info = await stat(root)
    if (!info.isDirectory()) return { state: 'absent' }
  } catch {
    return { state: 'absent' }
  }
  const measurement = await measureDirectorySize(root, new Set())
  return measurement.state === 'measured'
    ? { state: 'measured', bytes: measurement.bytes }
    : { state: 'unavailable', reason: measurement.reason }
}

// Deleting ONE session releases the run data that session owned. It sits one level deeper than the
// project's — `<dataRoot>/notebooks/<projectId>/<sessionId>` — and no deletion path named it: a session
// whose results were 1.1 GB left every byte behind while the app said the session was deleted.
//
// The caller orders this AFTER the durable session record is gone. That order is the safety property: if
// the session could not be deleted, its run data must never be the thing that disappeared first.
export const deleteSessionNotebookData = async (
  options: SessionNotebookDataCleanupOptions,
  projectId: string,
  sessionId: string
): Promise<SessionNotebookDataCleanupResult> => {
  if (!SAFE_ID_SEGMENT.test(projectId)) {
    options.log?.info('session notebook data refused', { reason: 'unsafe-project-id' })
    return { freedBytes: 0, state: 'refused' }
  }
  if (!SAFE_ID_SEGMENT.test(sessionId)) {
    options.log?.info('session notebook data refused', { reason: 'unsafe-session-id' })
    return { freedBytes: 0, state: 'refused' }
  }

  const root = join(options.dataRoot, 'notebooks', projectId, sessionId)
  try {
    const info = await stat(root)
    if (!info.isDirectory()) {
      options.log?.info('session notebook data absent', { projectId, sessionId })
      return { freedBytes: 0, state: 'absent' }
    }
  } catch {
    options.log?.info('session notebook data absent', { projectId, sessionId })
    return { freedBytes: 0, state: 'absent' }
  }

  const measurement = await measureDirectorySize(root, new Set())
  try {
    await rm(root, { recursive: true, force: true })
  } catch (error) {
    // The session record is already gone, so the user has no session left to retry from. Name the outcome
    // instead of reporting bytes that are still on disk.
    options.log?.info('session notebook data removal failed', {
      projectId,
      sessionId,
      reason: error instanceof Error ? error.message : String(error)
    })
    return { freedBytes: 0, state: 'failed' }
  }
  options.log?.info('session notebook data removed', {
    projectId,
    sessionId,
    ...describeNotebookBytes(measurement)
  })
  return {
    freedBytes: measurement.state === 'measured' ? measurement.bytes : 0,
    state: 'removed',
    ...(measurement.state === 'unavailable' ? { freedBytesState: measurement.reason } : {})
  }
}
