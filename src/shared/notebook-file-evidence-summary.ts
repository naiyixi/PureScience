// Session-level projection of the per-run file evidence (R3). The panel needs one honest sentence per
// axis, and the sentence depends on WHY data is missing: "this session read no existing files" and
// "this session's reads were not captured" are different claims, and a run written before the evidence
// existed is a third. Keeping the projection pure lets the wording be unit-tested instead of eyeballed.

import type {
  NotebookFileEvidenceReason,
  NotebookReadFileKind,
  NotebookRunRecord
} from './notebook'

export type ReadInRow = {
  runId: string
  relativePath: string
  kind: NotebookReadFileKind
  reads?: number
  startedAt?: number
  source: string
}

// How complete one axis was across the session's runs, plus the reasons that were given for the gaps.
export type AxisSummary = {
  captured: number
  truncated: number
  // Total number of entries the captures could not record, summed over runs.
  dropped: number
  unavailable: number
  unsupported: number
  unattributed: number
  // Named reasons, in the order they first appeared (deduplicated).
  reasons: NotebookFileEvidenceReason[]
}

export type FileEvidenceSummary = {
  read: AxisSummary
  write: AxisSummary
  readRows: ReadInRow[]
  // Paths seen changing in a directory two sessions shared, kept out of any run's file list.
  observedPaths: string[]
  // Runs whose record predates the evidence entirely: their file activity is unknown, not empty.
  runsWithoutEvidence: number
  runsWithEvidence: number
}

const emptyAxis = (): AxisSummary => ({
  captured: 0,
  truncated: 0,
  dropped: 0,
  unavailable: 0,
  unsupported: 0,
  unattributed: 0,
  reasons: []
})

const addReason = (axis: AxisSummary, reason: NotebookFileEvidenceReason): void => {
  if (!axis.reasons.includes(reason)) axis.reasons.push(reason)
}

const summarizeReadAxis = (
  axis: AxisSummary,
  evidence: NotebookRunRecord['fileEvidence']
): void => {
  if (!evidence) return
  const read = evidence.read
  axis.captured += read.readStatus === 'captured' ? 1 : 0
  axis.truncated += read.readStatus === 'truncated' ? 1 : 0
  if (read.readStatus === 'truncated') axis.dropped += read.readTruncatedCount
  if (read.readStatus === 'unavailable') axis.unavailable += 1
  if (read.readStatus === 'unsupported') axis.unsupported += 1
  if (read.readStatus !== 'captured' && read.readStatus !== 'truncated') {
    addReason(axis, read.readReason)
  }
}

const summarizeWriteAxis = (
  axis: AxisSummary,
  evidence: NotebookRunRecord['fileEvidence'],
  observedPaths: string[]
): void => {
  if (!evidence) return
  const write = evidence.write
  switch (write.status) {
    case 'captured':
      axis.captured += 1
      break
    case 'truncated':
      axis.truncated += 1
      axis.dropped += write.droppedCount
      break
    case 'unavailable':
      axis.unavailable += 1
      addReason(axis, write.reason)
      break
    case 'unsupported':
      axis.unsupported += 1
      addReason(axis, write.reason)
      break
    case 'unattributed':
      axis.unattributed += 1
      addReason(axis, write.reason)
      if (write.droppedCount !== undefined) axis.dropped += write.droppedCount
      for (const path of write.observedPaths ?? []) {
        if (!observedPaths.includes(path)) observedPaths.push(path)
      }
      break
  }
}

export const summarizeFileEvidence = (
  runs: ReadonlyArray<NotebookRunRecord>
): FileEvidenceSummary => {
  const read = emptyAxis()
  const write = emptyAxis()
  const readRows: ReadInRow[] = []
  const observedPaths: string[] = []
  let runsWithoutEvidence = 0
  let runsWithEvidence = 0

  for (const run of runs) {
    if (!run.fileEvidence) {
      runsWithoutEvidence += 1
      continue
    }
    runsWithEvidence += 1
    summarizeReadAxis(read, run.fileEvidence)
    summarizeWriteAxis(write, run.fileEvidence, observedPaths)
    if (
      run.fileEvidence.read.readStatus === 'captured' ||
      run.fileEvidence.read.readStatus === 'truncated'
    ) {
      for (const file of run.fileEvidence.read.read) {
        readRows.push({
          runId: run.runId,
          relativePath: file.relativePath,
          kind: file.kind,
          ...(file.reads === undefined ? {} : { reads: file.reads }),
          ...(run.startedAt === undefined ? {} : { startedAt: run.startedAt }),
          source: run.source ?? 'cell'
        })
      }
    }
  }

  // Newest run first, then path — the same ordering rule the write table uses.
  readRows.sort(
    (left, right) =>
      (right.startedAt ?? 0) - (left.startedAt ?? 0) ||
      left.relativePath.localeCompare(right.relativePath)
  )

  return { read, write, readRows, observedPaths, runsWithoutEvidence, runsWithEvidence }
}

// Which single sentence the read axis deserves. Ordered from "we looked and it was empty" to "we could
// not look at all", with the mixed case stated as mixed rather than collapsed into either extreme.
export type AxisVerdict =
  | { kind: 'none' }
  | { kind: 'complete' }
  | { kind: 'partial'; dropped: number }
  | { kind: 'mixed'; captured: number; missing: number }
  | {
      kind: 'missing'
      status: 'unsupported' | 'unavailable' | 'unattributed'
      reasons: NotebookFileEvidenceReason[]
    }

export const axisVerdict = (axis: AxisSummary): AxisVerdict => {
  const total =
    axis.captured + axis.truncated + axis.unavailable + axis.unsupported + axis.unattributed
  if (total === 0) return { kind: 'none' }
  const missing = axis.unavailable + axis.unsupported + axis.unattributed
  if (missing === 0) {
    return axis.dropped > 0 ? { kind: 'partial', dropped: axis.dropped } : { kind: 'complete' }
  }
  if (axis.captured + axis.truncated === 0) {
    const status =
      axis.unavailable > 0 ? 'unavailable' : axis.unsupported > 0 ? 'unsupported' : 'unattributed'
    return { kind: 'missing', status, reasons: axis.reasons }
  }
  return { kind: 'mixed', captured: axis.captured + axis.truncated, missing }
}
