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
  NotebookFileContentState,
  NotebookFileEvidenceReason,
  NotebookReadFileKind,
  NotebookRunRecord
} from '../../../../shared/notebook'
import {
  axisVerdict,
  summarizeFileEvidence
} from '../../../../shared/notebook-file-evidence-summary'
import {
  buildNotebookWriteAuditRows,
  shortContentHash,
  type NotebookWriteAuditRow,
  type NotebookWriteChangeKind
} from '../../../../shared/notebook-write-audit-rows'

type WriteAuditPanelProps = {
  runs: NotebookRunRecord[]
}

type ChangeKind = NotebookWriteChangeKind

const IDENTITY_DASH = '—'

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

// One side of a change's content identity: eight hex characters when the bytes were hashed, otherwise the
// NAMED reason they were not. The word matters — a dash would leave the reader unable to tell "nobody
// recorded it" from "it could not be read", which are different promises.
const contentSideLabel = (
  t: (key: TranslationKey) => string,
  hash: string | undefined,
  state: NotebookFileContentState | undefined
): string => {
  const short = shortContentHash(hash)
  if (short !== undefined) return short
  if (state === undefined || state === 'recorded') return IDENTITY_DASH
  return t(CONTENT_STATE_LABEL_KEYS[state])
}

// The whole identity, `before → after`. Undefined only when the record carries no content identity at all
// (a row written before the field existed): that row stays quiet, and the panel's capture notices explain
// why a run can lack it.
const identityLine = (
  t: (key: TranslationKey) => string,
  row: NotebookWriteAuditRow
): string | undefined => {
  if (!row.content) return undefined
  const before = contentSideLabel(t, row.content.hashes.before, row.content.states.before)
  const after = contentSideLabel(t, row.content.hashes.after, row.content.states.after)
  return `${before} → ${after}`
}

// Exhaustive by type over everything except 'recorded' (which means a hash EXISTS, so it has no word):
// a new content state cannot be added without deciding what to call it, so the panel never shows a raw
// state code at the user — the same rule the evidence reasons above follow.
const CONTENT_STATE_LABEL_KEYS: Record<
  Exclude<NotebookFileContentState, 'recorded'>,
  TranslationKey
> = {
  'did-not-exist': 'writeAudit.contentMissing.did-not-exist',
  'not-recorded': 'writeAudit.contentMissing.not-recorded',
  'too-large': 'writeAudit.contentMissing.too-large',
  unreadable: 'writeAudit.contentMissing.unreadable'
}

const WriteAuditPanel = ({ runs }: WriteAuditPanelProps): React.JSX.Element => {
  const { t } = useLanguage()
  const [kindFilter, setKindFilter] = useState<ChangeKind | 'all'>('all')

  const rows = useMemo(() => buildNotebookWriteAuditRows(runs), [runs])

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
                  key={`${row.runId}-${row.path}-${index}`}
                  className="border-b border-border-100 last:border-0"
                  data-testid="write-audit-row"
                >
                  <td className="py-1.5 pr-2 font-mono text-text-100">
                    {row.relativePath}
                    {/* Content identity as machine text on purpose: the recipe is sha256 and a third party
                        recomputes it from the file itself, so it needs no translation. A side without a hash
                        shows a dash — a NAMED state in the record, never an empty file (which still hashes). */}
                    {identityLine(t, row) ? (
                      <span
                        className="mt-0.5 block text-[10px] text-text-400"
                        data-testid="write-audit-identity"
                      >
                        {identityLine(t, row)}
                      </span>
                    ) : null}
                  </td>
                  <td className="py-1.5 pr-2">
                    {row.changeKind ? (
                      <span
                        className={cn(
                          'rounded px-1 py-0.5 text-[10px] font-medium uppercase',
                          KIND_STYLES[row.changeKind] ?? ''
                        )}
                        data-testid="write-audit-change-badge"
                      >
                        {t(KIND_LABEL_KEYS[row.changeKind])}
                      </span>
                    ) : (
                      // A record written before the field existed does not say whether the file was created or
                      // modified; printing 'modified' here was a guess the record never made. A dash is the
                      // truth, and the panel's capture notices explain why a row can lack it.
                      <span className="text-text-400" data-testid="write-audit-change-unrecorded">
                        {IDENTITY_DASH}
                      </span>
                    )}
                  </td>
                  <td className="py-1.5 pr-2 text-text-300">{formatBytes(row.size)}</td>
                  <td className="py-1.5 pr-2 text-text-300">{formatTime(row.mtimeMs)}</td>
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
