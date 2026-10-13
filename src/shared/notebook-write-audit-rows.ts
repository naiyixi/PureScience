// Session-level write-audit rows (v2.1.0, B3): the projection the Write-audit panel renders, kept out of the
// component so the ordering and the honesty rules can be tested without a DOM.
//
// Two fields are deliberately OPTIONAL, and both mean "the record does not say":
//   · `changeKind` — records written before the field existed carry no kind. The panel used to print
//     'modified' for those, which is a guess between created/modified that the record never made.
//   · `content`    — the content identity (before/after sha256 or a NAMED state). Absent (not "empty") on
//     records written before the field existed: a legacy row must never read as "the content is known".

import type { NotebookRunRecord, NotebookWorkingFile, NotebookWorkingFileContent } from './notebook'

type NotebookWriteChangeKind = 'created' | 'modified' | 'removed'

type NotebookWriteAuditRow = {
  path: string
  relativePath: string
  kind: NotebookWorkingFile['kind']
  changeKind?: NotebookWriteChangeKind
  content?: NotebookWorkingFileContent
  size?: number
  mtimeMs?: number
  runId: string
  runIndex?: number
  source: string
  startedAt?: number
}

/** Newest run first, then by mtime — the order the panel has always shown. */
const buildNotebookWriteAuditRows = (
  runs: readonly NotebookRunRecord[]
): NotebookWriteAuditRow[] => {
  const collected: NotebookWriteAuditRow[] = []
  for (const run of runs) {
    for (const file of run.workingFiles ?? []) {
      collected.push({
        path: file.path,
        relativePath: file.relativePath ?? file.path,
        kind: file.kind,
        ...(file.changeKind === undefined ? {} : { changeKind: file.changeKind }),
        ...(file.content === undefined ? {} : { content: file.content }),
        ...(file.size === undefined ? {} : { size: file.size }),
        ...(file.mtimeMs === undefined ? {} : { mtimeMs: file.mtimeMs }),
        runId: run.runId,
        ...(run.executionCount === undefined ? {} : { runIndex: run.executionCount }),
        source: run.source ?? 'cell',
        ...(run.startedAt === undefined ? {} : { startedAt: run.startedAt })
      })
    }
  }

  return collected.sort(
    (a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0) || (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0)
  )
}

/**
 * The short form of one side of a change: eight hex characters, or undefined when this side has no hash
 * (a NAMED state, not an empty file — an empty file still has a hash).
 */
const shortContentHash = (value: string | undefined): string | undefined =>
  typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) ? value.slice(0, 8) : undefined

export { buildNotebookWriteAuditRows, shortContentHash }
export type { NotebookWriteAuditRow, NotebookWriteChangeKind }
