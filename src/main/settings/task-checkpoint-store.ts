// Project-scoped task checkpoint store (v1.53): one JSON document per project, written atomically
// (tmp + rename) so a crashed write can never leave a half-parsed checkpoint. The directory is
// injected so the store stays testable and the caller owns project-path resolution.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import {
  TASK_CHECKPOINT_FILE_NAME,
  emptyTaskCheckpoint,
  isTaskCheckpoint,
  mergeTaskCheckpoint,
  type TaskCheckpoint,
  type TaskCheckpointPatch
} from '../../shared/task-checkpoint'

export type { TaskCheckpoint, TaskCheckpointPatch }

export class TaskCheckpointStore {
  constructor(private readonly resolveProjectDirectory: (projectId: string) => string) {}

  private filePath(projectId: string): string {
    return join(this.resolveProjectDirectory(projectId), TASK_CHECKPOINT_FILE_NAME)
  }

  // Reads and validates the checkpoint. A missing file returns null; a file written by an older
  // schema or corrupted JSON also returns null (the caller re-derives state instead of trusting it).
  async read(projectId: string): Promise<TaskCheckpoint | null> {
    let raw: string
    try {
      raw = await readFile(this.filePath(projectId), 'utf8')
    } catch {
      return null
    }
    try {
      const parsed: unknown = JSON.parse(raw)
      return isTaskCheckpoint(parsed) ? parsed : null
    } catch {
      return null
    }
  }

  async write(projectId: string, checkpoint: TaskCheckpoint): Promise<void> {
    const path = this.filePath(projectId)
    await mkdir(dirname(path), { recursive: true })
    const temporary = `${path}.tmp-${process.pid}`
    await writeFile(temporary, `${JSON.stringify(checkpoint, null, 2)}\n`, 'utf8')
    await rename(temporary, path)
  }

  // Merge-on-write: the agent patches wherever it is, and nothing already recorded is lost.
  async apply(
    projectId: string,
    patch: TaskCheckpointPatch,
    now: string = new Date().toISOString()
  ): Promise<TaskCheckpoint> {
    const base = (await this.read(projectId)) ?? emptyTaskCheckpoint(projectId, now)
    const merged = mergeTaskCheckpoint(base, patch, now)
    await this.write(projectId, merged)
    return merged
  }
}

export { TASK_CHECKPOINT_FILE_NAME }
