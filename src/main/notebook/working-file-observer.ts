import { watch, type FSWatcher } from 'node:fs'
import { lstat, readdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

import type {
  NotebookFileCapture,
  NotebookFileEvidenceReason,
  NotebookWorkingFile
} from '../../shared/notebook'
import {
  capturedWriteEvidence,
  truncatedWriteEvidence,
  unattributedWriteEvidence,
  unavailableWriteEvidence
} from '../../shared/notebook'

type WorkingFileObservationRequest = {
  dataRoot: string
  notebookSessionRoot: string
}

// 'capture' is the shared write-axis vocabulary, so the observer's own honesty rule (a list that is
// short or missing says so) is the same one the run record and the interface speak.
type WorkingFileObservation = {
  finish: () => Promise<WorkingFileObservationResult>
}

type WorkingFileObservationResult = {
  files: NotebookWorkingFile[]
  capture: NotebookFileCapture
}

type WorkingFileObservationDependencies = {
  watchDirectory?: typeof watch
  // The bound is a promise to the user ("this list is short by N"), so tests need to reach it without
  // staging ten thousand files.
  maxChangedPaths?: number
}

type ActiveObservation = {
  conflicted: boolean
}

const activeByDataRoot = new Map<string, Set<ActiveObservation>>()
const MAX_CHANGED_PATHS = 10_000
const MAX_FALLBACK_SNAPSHOT_ENTRIES = 50_000
const EVENT_SETTLE_MS = 20
const WATCHER_READY_MS = 5

const isPathInside = (root: string, candidate: string): boolean => {
  const nested = relative(root, candidate)
  return nested === '' || (!isAbsolute(nested) && nested !== '..' && !nested.startsWith(`..${sep}`))
}

// Notebook metadata is persisted and exchanged as a portable path, independent of the host OS.
const toPortableNotebookRelativePath = (path: string, hostSeparator = sep): string =>
  hostSeparator === '/' ? path : path.split(hostSeparator).join('/')

const unavailableObservation = (): WorkingFileObservation => ({
  finish: async () => ({
    files: [],
    capture: unavailableWriteEvidence('observation-unavailable')
  })
})

const registerObservation = (dataRoot: string, observation: ActiveObservation): (() => void) => {
  const active = activeByDataRoot.get(dataRoot) ?? new Set<ActiveObservation>()
  if (active.size > 0) {
    observation.conflicted = true
    for (const existing of active) existing.conflicted = true
  }
  active.add(observation)
  activeByDataRoot.set(dataRoot, active)

  return () => {
    active.delete(observation)
    if (active.size === 0) activeByDataRoot.delete(dataRoot)
  }
}

// An over-limit capture is short but real, so it keeps its list and reports the shortfall; a
// conflicted one is labelled instead of thrown away. Both facts can hold at once.
// On a shared directory the observation is kept but never handed over as this run's file list: the
// paths belong to the other session too, and workingFiles feeds artifact provenance, where attributing
// another run's file to this one is a false claim rather than a gap. captureFrom therefore returns the
// paths inside the evidence, and the caller withholds them from the list.
const captureFrom = (
  dropped: number,
  conflicted: boolean,
  observedPaths: string[]
): NotebookFileCapture => {
  if (conflicted) {
    return unattributedWriteEvidence('attribution-conflict', {
      droppedCount: dropped > 0 ? dropped : undefined,
      observedPaths
    })
  }
  return dropped > 0 ? truncatedWriteEvidence(dropped) : capturedWriteEvidence()
}

const settleWatcherEvents = (): Promise<void> =>
  new Promise((resolveSettled) => setTimeout(resolveSettled, EVENT_SETTLE_MS))

const waitForWatcherReady = (): Promise<void> =>
  new Promise((resolveReady) => setTimeout(resolveReady, WATCHER_READY_MS))

type SnapshotEntry = NotebookWorkingFile & { ctimeMs: number }

const resolveChangedFile = async (
  dataRoot: string,
  logicalDataRoot: string,
  logicalSessionRoot: string,
  candidatePath: string
): Promise<SnapshotEntry | undefined> => {
  try {
    const linkMetadata = await lstat(candidatePath)
    if (linkMetadata.isSymbolicLink()) return undefined

    const canonicalPath = await realpath(candidatePath)
    if (!isPathInside(dataRoot, canonicalPath)) return undefined
    const metadata = await stat(canonicalPath)
    if (!metadata.isFile()) return undefined
    const logicalPath = resolve(logicalDataRoot, relative(dataRoot, canonicalPath))

    return {
      path: logicalPath,
      relativePath: toPortableNotebookRelativePath(relative(logicalSessionRoot, logicalPath)),
      kind: 'other',
      size: metadata.size,
      mtimeMs: metadata.mtimeMs,
      ctimeMs: metadata.ctimeMs
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

const diffSnapshots = (
  before: ReadonlyMap<string, SnapshotEntry>,
  after: ReadonlyMap<string, SnapshotEntry>
): NotebookWorkingFile[] => {
  const changed: NotebookWorkingFile[] = []
  // Files present after the run: created (no before entry) or modified (metadata changed).
  for (const file of after.values()) {
    const previous = before.get(file.path)
    const isNew = !previous
    const isModified =
      previous !== undefined &&
      (previous.size !== file.size ||
        previous.mtimeMs !== file.mtimeMs ||
        previous.ctimeMs !== file.ctimeMs)
    if (!isNew && !isModified) continue
    changed.push({
      path: file.path,
      relativePath: file.relativePath,
      kind: file.kind,
      changeKind: isNew ? 'created' : 'modified',
      size: file.size,
      mtimeMs: file.mtimeMs
    })
  }
  // Files that existed before but are gone after: removed by the run. The observer captures the
  // before-entry's metadata so the audit still shows what was deleted.
  for (const [path, entry] of before.entries()) {
    if (!after.has(path)) {
      changed.push({
        path: entry.path,
        relativePath: entry.relativePath,
        kind: entry.kind,
        changeKind: 'removed',
        size: entry.size,
        mtimeMs: entry.mtimeMs
      })
    }
  }
  return changed
}

// A snapshot either succeeds or fails for a NAMED reason: "the tree was too large to snapshot" and
// "the tree could not be read" lead to different promises to the user, and collapsing both into an
// undefined used to make them indistinguishable from "nothing changed".
type FallbackSnapshot =
  | { ok: true; files: Map<string, SnapshotEntry> }
  | { ok: false; reason: 'limit-exceeded' | 'observation-unavailable' }

const captureFallbackSnapshot = async (
  dataRoot: string,
  logicalDataRoot: string,
  logicalSessionRoot: string
): Promise<FallbackSnapshot> => {
  try {
    const files = new Map<string, SnapshotEntry>()
    let entriesSeen = 0
    let exceeded = false

    const visit = async (directory: string): Promise<void> => {
      if (exceeded) return
      const entries = await readdir(directory, { withFileTypes: true })
      entries.sort((left, right) => left.name.localeCompare(right.name))
      for (const entry of entries) {
        if (exceeded) return
        entriesSeen += 1
        if (entriesSeen > MAX_FALLBACK_SNAPSHOT_ENTRIES) {
          exceeded = true
          return
        }

        const candidatePath = join(directory, entry.name)
        if (entry.isSymbolicLink()) continue
        if (entry.isDirectory()) {
          await visit(candidatePath)
          continue
        }
        if (!entry.isFile()) continue

        const canonicalPath = await realpath(candidatePath)
        if (!isPathInside(dataRoot, canonicalPath))
          throw new Error('Working file escaped data root.')
        const metadata = await stat(canonicalPath)
        const logicalPath = resolve(logicalDataRoot, relative(dataRoot, canonicalPath))
        files.set(logicalPath, {
          path: logicalPath,
          relativePath: toPortableNotebookRelativePath(relative(logicalSessionRoot, logicalPath)),
          kind: 'other',
          size: metadata.size,
          mtimeMs: metadata.mtimeMs,
          ctimeMs: metadata.ctimeMs
        })
      }
    }

    await visit(dataRoot)
    if (exceeded) return { ok: false, reason: 'limit-exceeded' }
    return { ok: true, files }
  } catch {
    return { ok: false, reason: 'observation-unavailable' }
  }
}

const startFallbackObservation = async (
  dataRoot: string,
  logicalDataRoot: string,
  logicalSessionRoot: string
): Promise<WorkingFileObservation> => {
  const active: ActiveObservation = { conflicted: false }
  const unregister = registerObservation(dataRoot, active)
  const before = await captureFallbackSnapshot(dataRoot, logicalDataRoot, logicalSessionRoot)
  let finished = false
  let finishedResult: WorkingFileObservationResult = {
    files: [],
    capture: unavailableWriteEvidence('observation-unavailable')
  }

  return {
    finish: async () => {
      if (finished) return finishedResult
      finished = true
      const after = await captureFallbackSnapshot(dataRoot, logicalDataRoot, logicalSessionRoot)
      unregister()
      if (!before.ok) {
        finishedResult = { files: [], capture: unavailableWriteEvidence(before.reason) }
      } else if (!after.ok) {
        finishedResult = { files: [], capture: unavailableWriteEvidence(after.reason) }
      } else if (active.conflicted) {
        // The diff covers both sessions' writes, so it is offered as an observation, not as this run's
        // file list — and the run still says why its own list is empty.
        const diffed = diffSnapshots(before.files, after.files)
        finishedResult = {
          files: [],
          capture: unattributedWriteEvidence('attribution-conflict', {
            observedPaths: diffed.map((file) => file.relativePath)
          })
        }
      } else {
        finishedResult = {
          files: diffSnapshots(before.files, after.files),
          capture: capturedWriteEvidence()
        }
      }
      return finishedResult
    }
  }
}

const startWorkingFileObservation = async (
  request: WorkingFileObservationRequest,
  dependencies: WorkingFileObservationDependencies = {}
): Promise<WorkingFileObservation> => {
  let watcher: FSWatcher | undefined
  try {
    const logicalDataRoot = resolve(request.dataRoot)
    const logicalSessionRoot = resolve(request.notebookSessionRoot)
    const [dataRoot, sessionRoot] = await Promise.all([
      realpath(request.dataRoot),
      realpath(request.notebookSessionRoot)
    ])
    if (!isPathInside(sessionRoot, dataRoot)) return unavailableObservation()

    const maxChangedPaths = dependencies.maxChangedPaths ?? MAX_CHANGED_PATHS
    const active: ActiveObservation = { conflicted: false }
    const changedPaths = new Set<string>()
    // Named, not a boolean: 'the watch went bad' and 'the tree was too big' used to collapse into the
    // same empty result as 'nothing changed'.
    let failureReason: NotebookFileEvidenceReason | undefined
    // Distinct changed paths past MAX_CHANGED_PATHS that could not be recorded. Counting them is what
    // lets the run say "this list is short by N" instead of dropping the whole list.
    let dropped = 0
    let finished = false
    let finishedResult: WorkingFileObservationResult = {
      files: [],
      capture: unavailableWriteEvidence('observation-unavailable')
    }

    try {
      watcher = (dependencies.watchDirectory ?? watch)(
        dataRoot,
        { recursive: true },
        (_eventType, filename) => {
          if (failureReason) return
          if (!filename) {
            failureReason = 'observation-unavailable'
            return
          }

          const eventPath = filename.toString()
          if (isAbsolute(eventPath)) {
            failureReason = 'observation-unavailable'
            return
          }
          const candidatePath = resolve(dataRoot, eventPath)
          if (!isPathInside(dataRoot, candidatePath)) {
            failureReason = 'observation-unavailable'
            return
          }
          if (changedPaths.size >= maxChangedPaths) {
            // Only NEW paths are counted: a repeated event for an already-recorded path is not a
            // dropped entry, and counting it would inflate the shortfall.
            if (!changedPaths.has(candidatePath)) dropped += 1
            return
          }

          changedPaths.add(candidatePath)
        }
      )
    } catch {
      return startFallbackObservation(dataRoot, logicalDataRoot, logicalSessionRoot)
    }
    watcher.on('error', () => {
      failureReason ??= 'observation-unavailable'
    })
    await waitForWatcherReady()
    if (failureReason) {
      watcher.close()
      return startFallbackObservation(dataRoot, logicalDataRoot, logicalSessionRoot)
    }
    // Recursive watchers can replay pre-existing paths while their initial scan settles. Execution
    // has not started yet, so those events cannot prove this run created or changed the files.
    changedPaths.clear()
    const before = await captureFallbackSnapshot(dataRoot, logicalDataRoot, logicalSessionRoot)
    const unregister = registerObservation(dataRoot, active)

    return {
      finish: async () => {
        if (finished) return finishedResult
        finished = true
        if (!active.conflicted) await settleWatcherEvents()
        watcher?.close()
        unregister()

        // The watcher saw something it cannot vouch for (a nameless or out-of-root event, or a
        // watcher error): the collected paths go with it and the reason stays.
        if (failureReason) {
          finishedResult = { files: [], capture: unavailableWriteEvidence(failureReason) }
          return finishedResult
        }
        // Without a before-snapshot the watcher's paths cannot be classified (a spurious event would
        // be indistinguishable from a real change), so the list is withheld and the reason kept.
        if (!before.ok) {
          finishedResult = { files: [], capture: unavailableWriteEvidence(before.reason) }
          return finishedResult
        }
        try {
          const candidates = await Promise.all(
            Array.from(changedPaths)
              .sort((left, right) => left.localeCompare(right))
              .map((candidatePath) =>
                resolveChangedFile(dataRoot, logicalDataRoot, logicalSessionRoot, candidatePath)
              )
          )
          const changedFiles = candidates
            .filter((file): file is SnapshotEntry => file !== undefined)
            .filter((file) => {
              const previous = before.files.get(file.path)
              return (
                !previous ||
                previous.size !== file.size ||
                previous.mtimeMs !== file.mtimeMs ||
                previous.ctimeMs !== file.ctimeMs
              )
            })
            .map((file) => ({
              path: file.path,
              relativePath: file.relativePath,
              kind: file.kind,
              size: file.size,
              mtimeMs: file.mtimeMs
            }))
          if (changedFiles.length === 0) {
            // macOS can deliver recursive watcher events after the bounded settle window. A full diff
            // is reserved for the empty/no-op event path so correctness does not impose two tree scans
            // on normal runs. Without it, "no changes" cannot be claimed — only "we did not see any".
            const after = await captureFallbackSnapshot(
              dataRoot,
              logicalDataRoot,
              logicalSessionRoot
            )
            if (!after.ok) {
              finishedResult = { files: [], capture: unavailableWriteEvidence(after.reason) }
              return finishedResult
            }
            const diffed = diffSnapshots(before.files, after.files)
            finishedResult = {
              files: active.conflicted ? [] : diffed,
              capture: captureFrom(
                dropped,
                active.conflicted,
                diffed.map((file) => file.relativePath)
              )
            }
            return finishedResult
          }

          finishedResult = {
            files: active.conflicted ? [] : changedFiles,
            capture: captureFrom(
              dropped,
              active.conflicted,
              changedFiles.map((file) => file.relativePath)
            )
          }
          return finishedResult
        } catch {
          finishedResult = { files: [], capture: unavailableWriteEvidence('capture-failed') }
          return finishedResult
        }
      }
    }
  } catch {
    watcher?.close()
    return unavailableObservation()
  }
}

export { startWorkingFileObservation, toPortableNotebookRelativePath }
export type { WorkingFileObservation }
