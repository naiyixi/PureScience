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
// directory, and treats "not there" as a named state rather than as zero bytes freed.

import { rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { dirSize } from '../storage/usage'

export type ProjectNotebookDataCleanupResult = {
  /** Bytes the removal actually freed; 0 for 'absent'/'refused'. */
  freedBytes: number
  state: 'removed' | 'absent' | 'refused'
}

type CleanupLogger = {
  info: (message: string, metadata: Record<string, unknown>) => void
}

export type ProjectNotebookDataCleanupOptions = {
  dataRoot: string
  log?: CleanupLogger
}

// A project id is an opaque cuid. Anything with a separator, a parent reference, or an unexpected shape is
// refused by name: this function deletes a directory recursively, so the id is a path-traversal boundary.
const SAFE_PROJECT_ID = /^[A-Za-z0-9_-]{1,64}$/

export const deleteProjectNotebookData = async (
  options: ProjectNotebookDataCleanupOptions,
  projectId: string
): Promise<ProjectNotebookDataCleanupResult> => {
  if (!SAFE_PROJECT_ID.test(projectId)) {
    options.log?.info('project notebook data refused', { reason: 'unsafe-project-id' })
    return { freedBytes: 0, state: 'refused' }
  }

  const root = join(options.dataRoot, 'notebooks', projectId)
  try {
    const info = await stat(root)
    if (!info.isDirectory()) return { freedBytes: 0, state: 'absent' }
  } catch {
    return { freedBytes: 0, state: 'absent' }
  }

  // Measured before the removal: afterwards the number would have to be remembered rather than read.
  const freedBytes = await dirSize(root, new Set()).catch(() => 0)
  await rm(root, { recursive: true, force: true })
  options.log?.info('project notebook data removed', { projectId, freedBytes })
  return { freedBytes, state: 'removed' }
}
