// WriteAuditPanel: session-level write audit. Aggregates every file the agent's code/shell
// executions created or modified (captured by the working-file observer around each run) into a
// scannable timeline: path, change kind, size, mtime, and which run produced it. This is the
// user-facing surface of the write-trace capability — what the agent wrote, when, and how big.

import { useMemo, useState } from 'react'
import { FilePenLine } from 'lucide-react'
import { cn } from '@/lib/utils'

import type { NotebookRunRecord, NotebookWorkingFile } from '../../../../shared/notebook'

type WriteAuditPanelProps = {
  runs: NotebookRunRecord[]
}

type ChangeKind = 'created' | 'modified' | 'removed'

const CHANGE_KINDS: ChangeKind[] = ['created', 'modified', 'removed']

const KIND_LABELS: Record<ChangeKind, string> = {
  created: 'created',
  modified: 'modified',
  removed: 'removed'
}

const KIND_STYLES: Record<ChangeKind, string> = {
  created: 'bg-green-50 text-green-700 dark:bg-green-950/20 dark:text-green-300',
  modified: 'bg-yellow-50 text-yellow-700 dark:bg-yellow-950/20 dark:text-yellow-300',
  removed: 'bg-red-50 text-red-700 dark:bg-red-950/20 dark:text-red-300'
}

const formatBytes = (bytes: number | undefined): string => {
  if (bytes === undefined) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const formatTime = (mtimeMs: number | undefined): string => {
  if (mtimeMs === undefined) return ''
  return new Date(mtimeMs).toLocaleTimeString()
}

type AuditRow = {
  file: NotebookWorkingFile
  runId: string
  runIndex?: number
  changeKind: ChangeKind
  source: string
  startedAt?: number
}

const WriteAuditPanel = ({ runs }: WriteAuditPanelProps): React.JSX.Element => {
  const [kindFilter, setKindFilter] = useState<ChangeKind | 'all'>('all')

  const rows = useMemo<AuditRow[]>(() => {
    const collected: AuditRow[] = []
    for (const run of runs) {
      for (const file of run.workingFiles ?? []) {
        collected.push({
          file,
          runId: run.runId,
          runIndex: run.executionCount,
          changeKind: file.changeKind ?? 'modified',
          source: run.source ?? 'cell',
          startedAt: run.startedAt
        })
      }
    }
    // Newest run first, then by mtime.
    return collected.sort((a, b) => {
      const timeA = a.startedAt ?? 0
      const timeB = b.startedAt ?? 0
      return timeB - timeA || (b.file.mtimeMs ?? 0) - (a.file.mtimeMs ?? 0)
    })
  }, [runs])

  const filtered = kindFilter === 'all' ? rows : rows.filter((row) => row.changeKind === kindFilter)
  const created = rows.filter((row) => row.changeKind === 'created').length
  const modified = rows.filter((row) => row.changeKind === 'modified').length
  const removed = rows.filter((row) => row.changeKind === 'removed').length

  const filterButton = (value: ChangeKind | 'all', label: string): React.JSX.Element => (
    <button
      type="button"
      className={cn(
        'rounded px-2 py-0.5 text-[11px] font-medium transition-colors',
        kindFilter === value ? 'bg-bg-200 text-text-000' : 'text-text-400 hover:text-text-300'
      )}
      onClick={() => setKindFilter(value)}
      data-testid={`write-audit-filter-${value}`}
      aria-pressed={kindFilter === value}
    >
      {label}
    </button>
  )

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <div className="shrink-0 border-b border-border-200 px-4 py-3">
        <div className="flex items-center gap-2">
          <FilePenLine className="h-3.5 w-3.5 text-text-400" aria-hidden />
          <h2 className="text-[13px] font-semibold text-text-000">Write audit</h2>
        </div>
        <p className="mt-1 text-[11px] text-text-400">
          {rows.length} file change{rows.length === 1 ? '' : 's'} — created {created} · modified{' '}
          {modified} · removed {removed}
        </p>
        <div className="mt-2 flex items-center gap-1" role="group" aria-label="Filter by change kind">
          {filterButton('all', 'All')}
          {CHANGE_KINDS.map((kind) => filterButton(kind, KIND_LABELS[kind]))}
        </div>
      </div>

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto px-4 py-3">
        {filtered.length === 0 ? (
          <p className="text-xs text-text-400" data-testid="write-audit-empty">
            No file writes recorded for this session yet. File changes made by code and shell
            executions appear here.
          </p>
        ) : (
          <table className="w-full text-left text-[11px]" data-testid="write-audit-table">
            <thead>
              <tr className="border-b border-border-200 text-text-400">
                <th className="py-1 pr-2 font-medium">Path</th>
                <th className="py-1 pr-2 font-medium">Change</th>
                <th className="py-1 pr-2 font-medium">Size</th>
                <th className="py-1 pr-2 font-medium">Time</th>
                <th className="py-1 font-medium">Run</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((row, index) => (
                <tr
                  key={`${row.runId}-${row.file.path}-${index}`}
                  className="border-b border-border-100 last:border-0"
                  data-testid="write-audit-row"
                >
                  <td className="py-1.5 pr-2 font-mono text-text-100">{row.file.relativePath ?? row.file.path}</td>
                  <td className="py-1.5 pr-2">
                    <span
                      className={cn(
                        'rounded px-1 py-0.5 text-[10px] font-medium uppercase',
                        KIND_STYLES[row.changeKind] ?? ''
                      )}
                    >
                      {KIND_LABELS[row.changeKind] ?? row.changeKind}
                    </span>
                  </td>
                  <td className="py-1.5 pr-2 text-text-300">{formatBytes(row.file.size)}</td>
                  <td className="py-1.5 pr-2 text-text-300">{formatTime(row.file.mtimeMs)}</td>
                  <td className="py-1.5 text-text-400">
                    {row.runIndex !== undefined ? `#${row.runIndex}` : row.runId.slice(0, 8)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

export { WriteAuditPanel }

