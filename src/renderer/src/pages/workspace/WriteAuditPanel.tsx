// WriteAuditPanel: session-level file audit. One half is what the agent WROTE (aggregated from the
// working-file observer around each run: path, change kind, size, mtime, run); the other is what it
// READ from files that already existed. Both carry how complete the capture is, because "nothing
// here" has three different meanings — nothing happened, the capture could not look, or the record
// predates the evidence — and only one of them is good news.

import { useMemo, useState } from 'react'
import { FilePenLine } from 'lucide-react'
import { useLanguage, type TranslationKey } from '@/i18n'
import { cn } from '@/lib/utils'

import type {
  NotebookFileEvidenceReason,
  NotebookReadFileKind,
  NotebookRunRecord,
  NotebookWorkingFile
} from '../../../../shared/notebook'
import {
  axisVerdict,
  summarizeFileEvidence
} from '../../../../shared/notebook-file-evidence-summary'

type WriteAuditPanelProps = {
  runs: NotebookRunRecord[]
}

type ChangeKind = 'created' | 'modified' | 'removed'

const CHANGE_KINDS: ChangeKind[] = ['created', 'modified', 'removed']

const KIND_LABEL_KEYS: Record<ChangeKind, TranslationKey> = {
  created: 'writeAudit.changeCreated',
  modified: 'writeAudit.changeModified',
  removed: 'writeAudit.changeRemoved'
}

const KIND_STYLES: Record<ChangeKind, string> = {
  created: 'bg-green-50 text-green-700 dark:bg-green-950/20 dark:text-green-300',
  modified: 'bg-yellow-50 text-yellow-700 dark:bg-yellow-950/20 dark:text-yellow-300',
  removed: 'bg-red-50 text-red-700 dark:bg-red-950/20 dark:text-red-300'
}

// Only the kinds that reach the read table: 'missing' paths are surfaced as a notice instead, so a label
// for them would be a string nothing can ever render.
const READ_KIND_LABEL_KEYS: Record<Exclude<NotebookReadFileKind, 'missing'>, TranslationKey> = {
  input: 'writeAudit.readKindInput',
  intermediate: 'writeAudit.readKindIntermediate'
}

// Exhaustive by type: a new evidence reason cannot be added without deciding what to call it, so the
// interface can never fall back to showing a raw code like "capture-failed" at the user.
const REASON_LABEL_KEYS: Record<NotebookFileEvidenceReason, TranslationKey> = {
  'driver-without-read-capture': 'writeAudit.reason.driver-without-read-capture',
  'kernel-language-unsupported': 'writeAudit.reason.kernel-language-unsupported',
  'capture-failed': 'writeAudit.reason.capture-failed',
  'limit-exceeded': 'writeAudit.reason.limit-exceeded',
  'observation-unavailable': 'writeAudit.reason.observation-unavailable',
  'attribution-conflict': 'writeAudit.reason.attribution-conflict'
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
  const { t } = useLanguage()
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

  const summary = useMemo(() => summarizeFileEvidence(runs), [runs])
  const readVerdict = axisVerdict(summary.read)
  const writeVerdict = axisVerdict(summary.write)

  const reasonLabel = (reason: NotebookFileEvidenceReason): string => t(REASON_LABEL_KEYS[reason])

  // The read section is empty for a reason, and the reason decides the sentence. One shared "no reads"
  // line would tell the user a run read nothing when in fact nothing looked.
  const readEmptyBody =
    readVerdict.kind === 'none'
      ? t('writeAudit.readUnknown')
      : readVerdict.kind === 'missing'
        ? t('writeAudit.readUncaptured').replace(
            '{reason}',
            readVerdict.reasons.map(reasonLabel).join(' · ')
          )
        : t('writeAudit.readEmpty')

  const notice = (text: string, testId: string): React.JSX.Element => (
    <p
      className="mt-2 rounded border border-border-200 bg-bg-100 px-2 py-1 text-[11px] text-text-300"
      data-testid={testId}
    >
      {text}
    </p>
  )

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
          <h2 className="text-[13px] font-semibold text-text-000">{t('writeAudit.title')}</h2>
        </div>
        <p className="mt-1 text-[11px] text-text-400">
          {t('writeAudit.summary')
            .replace('{n}', String(rows.length))
            .replace('{s}', rows.length === 1 ? '' : 's')
            .replace('{created}', String(created))
            .replace('{modified}', String(modified))
            .replace('{removed}', String(removed))}
        </p>
        <div
          className="mt-2 flex items-center gap-1"
          role="group"
          aria-label={t('writeAudit.filterKind')}
        >
          {filterButton('all', t('writeAudit.filterAll'))}
          {CHANGE_KINDS.map((kind) => filterButton(kind, t(KIND_LABEL_KEYS[kind])))}
        </div>
      </div>

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto px-4 py-3">
        {filtered.length === 0 ? (
          <p className="text-xs text-text-400" data-testid="write-audit-empty">
            {t('writeAudit.emptyBody')}
          </p>
        ) : (
          <table className="w-full text-left text-[11px]" data-testid="write-audit-table">
            <thead>
              <tr className="border-b border-border-200 text-text-400">
                <th className="py-1 pr-2 font-medium">{t('writeAudit.columnPath')}</th>
                <th className="py-1 pr-2 font-medium">{t('writeAudit.columnChange')}</th>
                <th className="py-1 pr-2 font-medium">{t('writeAudit.columnSize')}</th>
                <th className="py-1 pr-2 font-medium">{t('writeAudit.columnTime')}</th>
                <th className="py-1 font-medium">{t('writeAudit.columnRun')}</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((row, index) => (
                <tr
                  key={`${row.runId}-${row.file.path}-${index}`}
                  className="border-b border-border-100 last:border-0"
                  data-testid="write-audit-row"
                >
                  <td className="py-1.5 pr-2 font-mono text-text-100">
                    {row.file.relativePath ?? row.file.path}
                  </td>
                  <td className="py-1.5 pr-2">
                    <span
                      className={cn(
                        'rounded px-1 py-0.5 text-[10px] font-medium uppercase',
                        KIND_STYLES[row.changeKind] ?? ''
                      )}
                    >
                      {t(KIND_LABEL_KEYS[row.changeKind])}
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

        {/* How complete the write capture was: a short list says it is short. */}
        {writeVerdict.kind === 'partial' &&
          notice(
            t('writeAudit.writeTruncated').replace('{n}', String(writeVerdict.dropped)),
            'write-audit-write-truncated'
          )}
        {(writeVerdict.kind === 'missing' || writeVerdict.kind === 'mixed') &&
          notice(
            t('writeAudit.writeUncaptured').replace(
              '{reason}',
              writeVerdict.kind === 'missing'
                ? writeVerdict.reasons.map(reasonLabel).join(' · ')
                : ''
            ),
            'write-audit-write-uncaptured'
          )}
        {summary.observedPaths.length > 0 &&
          notice(
            `${t('writeAudit.sharedDirectory').replace('{n}', String(summary.observedPaths.length))} ${t('writeAudit.observedPaths').replace('{paths}', summary.observedPaths.join(', '))}`,
            'write-audit-shared-directory'
          )}
        {summary.missingReadPaths.length > 0 &&
          notice(
            `${t('writeAudit.readMissing').replace('{n}', String(summary.missingReadPaths.length))} ${t('writeAudit.observedPaths').replace('{paths}', summary.missingReadPaths.join(', '))}`,
            'write-audit-read-missing'
          )}
        {summary.runsWithoutEvidence > 0 &&
          notice(
            t('writeAudit.legacyRuns').replace('{n}', String(summary.runsWithoutEvidence)),
            'write-audit-legacy-runs'
          )}

        {/* Reads: the other half of what a run touched. */}
        <div className="mt-4 border-t border-border-200 pt-3">
          <h3 className="text-[12px] font-semibold text-text-100">
            {t('writeAudit.readTitle')}
            <span className="ml-2 text-[11px] font-normal text-text-400">
              {t('writeAudit.summaryReads').replace('{n}', String(summary.readRows.length))}
            </span>
          </h3>
          {readVerdict.kind === 'partial' && (
            <p className="mt-1 text-[11px] text-text-400" data-testid="write-audit-read-truncated">
              {t('writeAudit.readTruncated').replace('{n}', String(readVerdict.dropped))}
            </p>
          )}
          {summary.readRows.length === 0 ? (
            <p className="mt-2 text-xs text-text-400" data-testid="write-audit-read-empty">
              {readEmptyBody}
            </p>
          ) : (
            <table
              className="mt-2 w-full text-left text-[11px]"
              data-testid="write-audit-read-table"
            >
              <thead>
                <tr className="border-b border-border-200 text-text-400">
                  <th className="py-1 pr-2 font-medium">{t('writeAudit.columnPath')}</th>
                  <th className="py-1 pr-2 font-medium">{t('writeAudit.columnKind')}</th>
                  <th className="py-1 pr-2 font-medium">{t('writeAudit.columnReads')}</th>
                  <th className="py-1 font-medium">{t('writeAudit.columnRun')}</th>
                </tr>
              </thead>
              <tbody>
                {summary.readRows.map((row, index) => (
                  <tr
                    key={`${row.runId}-${row.relativePath}-${index}`}
                    className="border-b border-border-100 last:border-0"
                    data-testid="write-audit-read-row"
                  >
                    <td className="py-1.5 pr-2 font-mono text-text-100">{row.relativePath}</td>
                    <td className="py-1.5 pr-2 text-text-300">
                      {t(READ_KIND_LABEL_KEYS[row.kind])}
                    </td>
                    <td className="py-1.5 pr-2 text-text-300">{row.reads ?? ''}</td>
                    <td className="py-1.5 text-text-400">{row.runId.slice(0, 8)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  )
}

export { WriteAuditPanel }
