import { X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { useLanguage, type TranslationKey } from '@/i18n'
import type {
  PdfAnnotationAnchor,
  PdfAnnotationAnchorCounts,
  PdfAnnotationExportReceipt,
  PdfAnnotationView
} from '../../../../../../shared/pdf-annotation-surface'
import type { PdfEmbeddedAnnotationImportReport } from '../../../../../../shared/pdf-annotation-import'
import type { PdfAnnotationImportFailureCode } from '../../../../../../shared/pdf-annotation-import'
import type {
  PdfAnnotationExportChannel,
  PdfAnnotationExportFailureCode
} from '../../../../../../shared/pdf-annotation-export'

// The annotation panel on a PDF preview (文档标注层 A3): what is stored on this file, what is stored on
// OTHER versions of it, and what an import actually did.
//
// The panel is where the two honesty rules are visible:
//
//   * an annotation that is not on the version on screen is LISTED, with its named state and the version
//     it belongs to, and the only thing that moves it is the reader pressing re-anchor. Nothing here
//     filters such an annotation out — a markup that silently disappeared when a file was rewritten is
//     the failure this state exists to prevent.
//   * the import answer is the import's own: "imported 3 of 5", "this file carries no annotations",
//     "these bytes were already imported", or a named refusal. There is no path that turns an import
//     that wrote nothing into a success line.

export type PdfAnnotationImportView =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'report'; report: PdfEmbeddedAnnotationImportReport }
  | { kind: 'failure'; code: PdfAnnotationImportFailureCode; message: string }
  /** The IPC call itself failed — an unreachable version, a closed window: named, not a silent no-op. */
  | { kind: 'failed'; message: string }

/**
 * The two export channels (文档标注层 A4) as the panel shows them.
 *
 * A receipt is the only state that names a file, and it names the channel's OWN output: `copy` for the
 * annotated channel, `notes` for the list channel. Nothing here can present a cancelled save as an
 * export, and nothing can present the notes channel as having produced a PDF.
 */
export type PdfAnnotationExportView =
  | { kind: 'idle' }
  | { kind: 'running'; channel: PdfAnnotationExportChannel }
  | { kind: 'receipt'; receipt: PdfAnnotationExportReceipt }
  | { kind: 'cancelled'; channel: PdfAnnotationExportChannel }
  | {
      kind: 'failure'
      channel: PdfAnnotationExportChannel
      code: PdfAnnotationExportFailureCode
      message: string
    }
  | { kind: 'failed'; channel: PdfAnnotationExportChannel; message: string }

export type PdfAnnotationPanelProps = {
  annotations: readonly PdfAnnotationView[]
  counts: PdfAnnotationAnchorCounts
  /**
   * The file version the counts are about, as the version authority resolved it. Rendered as plain data
   * attributes: which version these annotations belong to, and which bytes, is the one fact a reader (or
   * an acceptance run) must be able to read off the panel rather than infer.
   */
  anchor?: PdfAnnotationAnchor
  /** Set when the annotations could not be read at all; the panel then says so instead of showing empty. */
  loadError?: string
  onDelete: (annotationId: string) => void
  onReattach: (annotationId: string) => void
  /** The page a note is being written on, once the reader has placed one. */
  pendingNote?: { page: number }
  noteBody: string
  onNoteBodyChange: (body: string) => void
  onNoteSave: () => void
  onNoteCancel: () => void
  importer: PdfAnnotationImportView
  onImport: () => void
  exporter: PdfAnnotationExportView
  onExportAnnotated: () => void
  onExportNotes: () => void
  onClose: () => void
}

const pageOf = (view: PdfAnnotationView): number | undefined => {
  const selector = view.annotation.selector as unknown as Record<string, unknown>
  return typeof selector.page === 'number' ? selector.page : undefined
}

const quoteOf = (view: PdfAnnotationView): string => {
  const selector = view.annotation.selector as unknown as Record<string, unknown>
  if (selector.shape === 'text-range' && typeof selector.quote === 'string') return selector.quote
  return view.annotation.body
}

const ImportReport = ({
  importer,
  onImport
}: {
  importer: PdfAnnotationImportView
  onImport: () => void
}): React.JSX.Element => {
  const { t } = useLanguage()

  const status = (): React.JSX.Element => {
    if (importer.kind === 'idle') {
      return (
        <p data-testid="pdf-annotation-import-status" className="text-[11px] text-text-300">
          {t('pdfAnnotation.import.idleHint')}
        </p>
      )
    }
    if (importer.kind === 'running') {
      return (
        <p data-testid="pdf-annotation-import-status" className="text-[11px] text-text-300">
          {t('pdfAnnotation.import.running')}
        </p>
      )
    }
    if (importer.kind === 'failed') {
      return (
        <p
          data-testid="pdf-annotation-import-status"
          role="alert"
          className="text-[11px] text-rose-500"
        >
          {t('pdfAnnotation.import.failed', { message: importer.message })}
        </p>
      )
    }
    if (importer.kind === 'failure') {
      return (
        <div data-testid="pdf-annotation-import-status" role="alert" className="space-y-1">
          <p className="text-[11px] text-rose-500">
            {t('pdfAnnotation.import.failure', {
              reason: t(`pdfAnnotation.import.failureReason.${importer.code}` as TranslationKey)
            })}
          </p>
          {/* The refusal's own words: which version, which digest, what the parser said. Named detail is
              what makes a refusal actionable rather than a generic error. */}
          <p
            data-testid="pdf-annotation-import-failure-detail"
            className="text-[11px] text-text-300"
          >
            {importer.message}
          </p>
        </div>
      )
    }

    const report = importer.report
    return (
      <div
        data-testid="pdf-annotation-import-status"
        data-status={report.status}
        className="space-y-1"
      >
        <p className="text-[11px] text-text-100">
          {report.status === 'imported'
            ? t('pdfAnnotation.import.imported', {
                imported: report.imported,
                total: report.annotationsInFile
              })
            : report.status === 'unchanged'
              ? t('pdfAnnotation.import.unchanged')
              : report.status === 'no-annotations'
                ? t('pdfAnnotation.import.noAnnotations')
                : t('pdfAnnotation.import.noSupported')}
        </p>
        {report.kinds.length > 0 ? (
          <p
            data-testid="pdf-annotation-import-kinds"
            className="text-[11px] text-text-200 [overflow-wrap:anywhere]"
          >
            {report.kinds
              .map(
                (entry) =>
                  `${t(`pdfAnnotation.kind.${entry.kind}` as TranslationKey)} ×${entry.count}`
              )
              .join(' · ')}
          </p>
        ) : null}
        {report.status === 'imported' && report.skipped.length > 0 ? (
          <p
            data-testid="pdf-annotation-import-skipped-total"
            className="text-[11px] text-text-200"
          >
            {t('pdfAnnotation.import.skippedTotal', {
              count: report.skipped.reduce((sum, entry) => sum + entry.count, 0)
            })}
          </p>
        ) : null}
        {/* Every group the file carried and this build could not place: the reason, the file's own
            subtype, and how many. The first occurrence's explanation rides along as a title. */}
        {report.skipped.map((skip) => (
          <p
            key={`${skip.subtype}-${skip.reason}`}
            data-testid="pdf-annotation-import-skip"
            data-reason={skip.reason}
            data-count={skip.count}
            title={skip.detail}
            className="text-[11px] text-text-300"
          >
            {t('pdfAnnotation.import.skippedLine', {
              reason: t(`pdfAnnotation.import.skipReason.${skip.reason}` as TranslationKey),
              subtype: skip.subtype,
              count: skip.count
            })}
          </p>
        ))}
      </div>
    )
  }

  return (
    <section
      data-testid="pdf-annotation-import"
      className="space-y-1.5 border-b border-border-300/40 px-3 py-2"
    >
      <Button
        type="button"
        variant="ghost"
        size="sm"
        data-slot="pdf-annotation-import"
        className="h-7 px-2 text-[11px] text-text-100 hover:text-text-000"
        disabled={importer.kind === 'running'}
        onClick={onImport}
      >
        {t('pdfAnnotation.import.action')}
      </Button>
      {status()}
    </section>
  )
}

/**
 * The two export channels (文档标注层 A4).
 *
 * The panel is where the channels' honesty is visible: the annotated channel states the copy it wrote
 * AND the digest the source file had before and after it (the same number, or the export is not reported
 * as a success at all), and the notes channel states that it produces no PDF. What a copy could not carry
 * is listed with its named reason and count, so "7 of 9" is a number the reader can act on.
 */
const ExportReport = ({
  exporter,
  onExportAnnotated,
  onExportNotes
}: {
  exporter: PdfAnnotationExportView
  onExportAnnotated: () => void
  onExportNotes: () => void
}): React.JSX.Element => {
  const { t } = useLanguage()
  const running = exporter.kind === 'running'

  const receiptView = (receipt: PdfAnnotationExportReceipt): React.JSX.Element => {
    const total = receipt.skipped.reduce((sum, entry) => sum + entry.count, 0)
    return (
      <div
        data-testid="pdf-annotation-export-status"
        data-status="exported"
        data-channel={receipt.channel}
        data-anchor-checksum={receipt.anchorChecksum}
        className="space-y-1"
      >
        <p data-testid="pdf-annotation-export-summary" className="text-[11px] text-text-100">
          {t('pdfAnnotation.export.exported', {
            exported: receipt.annotationsExported,
            inStore: receipt.annotationsInStore,
            versionId: receipt.provenance.versionId
          })}
        </p>
        {receipt.copy ? (
          <p
            data-testid="pdf-annotation-export-copy"
            data-path={receipt.copy.path}
            data-bytes={receipt.copy.bytes}
            data-source-bytes={receipt.copy.sourceBytes}
            data-appended-bytes={receipt.copy.appendedBytes}
            className="text-[11px] text-text-200 [overflow-wrap:anywhere]"
          >
            {t('pdfAnnotation.export.copyLine', { path: receipt.copy.path })}
          </p>
        ) : null}
        {receipt.notes ? (
          <p
            data-testid="pdf-annotation-export-notes"
            data-path={receipt.notes.path}
            data-lines={receipt.notes.entryLines}
            className="text-[11px] text-text-200 [overflow-wrap:anywhere]"
          >
            {t('pdfAnnotation.export.notesLine', { path: receipt.notes.path })}
          </p>
        ) : null}
        {/* The channel's own fact, stated rather than inferred from the file name. */}
        {receipt.channel === 'notes' ? (
          <p data-testid="pdf-annotation-export-no-pdf" className="text-[10px] text-text-300">
            {t('pdfAnnotation.export.noPdf')}
          </p>
        ) : null}
        {receipt.sourceBytes ? (
          <p
            data-testid="pdf-annotation-export-source"
            data-checksum-before={receipt.sourceBytes.checksumBefore}
            data-checksum-after={receipt.sourceBytes.checksumAfter}
            data-anchor-checksum={receipt.anchorChecksum}
            className="text-[10px] text-text-300 [overflow-wrap:anywhere]"
          >
            {t('pdfAnnotation.export.sourceUnchanged', {
              checksumBefore: receipt.sourceBytes.checksumBefore,
              checksumAfter: receipt.sourceBytes.checksumAfter
            })}
          </p>
        ) : null}
        <p
          data-testid="pdf-annotation-export-provenance"
          className="text-[10px] text-text-300 [overflow-wrap:anywhere]"
        >
          {t('pdfAnnotation.export.versionLine', {
            versionId: receipt.provenance.versionId,
            checksum: receipt.provenance.checksum
          })}
        </p>
        {receipt.skipped.length > 0 ? (
          <div data-testid="pdf-annotation-export-skipped" className="space-y-0.5">
            <p
              data-testid="pdf-annotation-export-skipped-total"
              className="text-[11px] text-text-200"
            >
              {t('pdfAnnotation.export.skippedTotal', { count: total })}
            </p>
            {receipt.skipped.map((entry) => (
              <p
                key={entry.reason}
                data-testid="pdf-annotation-export-skip"
                data-reason={entry.reason}
                data-count={entry.count}
                title={entry.detail}
                className="text-[10px] text-text-300"
              >
                {t('pdfAnnotation.export.skippedLine', {
                  reason: t(`pdfAnnotation.export.skipReason.${entry.reason}` as TranslationKey),
                  count: entry.count
                })}
              </p>
            ))}
          </div>
        ) : null}
      </div>
    )
  }

  const status = (): React.JSX.Element | null => {
    if (exporter.kind === 'idle') return null
    if (exporter.kind === 'running') {
      return (
        <p
          data-testid="pdf-annotation-export-status"
          data-status="running"
          data-channel={exporter.channel}
          className="text-[11px] text-text-300"
        >
          {t('pdfAnnotation.export.running')}
        </p>
      )
    }
    if (exporter.kind === 'cancelled') {
      return (
        <p
          data-testid="pdf-annotation-export-status"
          data-status="cancelled"
          data-channel={exporter.channel}
          role="status"
          className="text-[11px] text-text-300"
        >
          {t('pdfAnnotation.export.cancelled')}
        </p>
      )
    }
    if (exporter.kind === 'failed') {
      return (
        <p
          data-testid="pdf-annotation-export-status"
          data-status="failed"
          data-channel={exporter.channel}
          role="alert"
          className="text-[11px] text-rose-500"
        >
          {t('pdfAnnotation.export.failed', { message: exporter.message })}
        </p>
      )
    }
    if (exporter.kind === 'failure') {
      return (
        <div
          data-testid="pdf-annotation-export-status"
          data-status="failure"
          data-channel={exporter.channel}
          data-code={exporter.code}
          role="alert"
          className="space-y-1"
        >
          <p className="text-[11px] text-rose-500">
            {t('pdfAnnotation.export.failure', {
              reason: t(`pdfAnnotation.export.failureReason.${exporter.code}` as TranslationKey)
            })}
          </p>
          <p
            data-testid="pdf-annotation-export-failure-detail"
            className="text-[11px] text-text-300 [overflow-wrap:anywhere]"
          >
            {exporter.message}
          </p>
        </div>
      )
    }
    return receiptView(exporter.receipt)
  }

  return (
    <section
      data-testid="pdf-annotation-export"
      data-channels="annotated-pdf notes"
      className="space-y-1.5 border-b border-border-300/40 px-3 py-2"
    >
      <p className="text-[11px] font-medium text-text-000">{t('pdfAnnotation.export.title')}</p>
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-slot="pdf-annotation-export-annotated"
          className="h-7 px-2 text-[11px] text-text-100 hover:text-text-000"
          disabled={running}
          onClick={onExportAnnotated}
        >
          {t('pdfAnnotation.export.annotatedAction')}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-slot="pdf-annotation-export-notes"
          className="h-7 px-2 text-[11px] text-text-100 hover:text-text-000"
          disabled={running}
          onClick={onExportNotes}
        >
          {t('pdfAnnotation.export.notesAction')}
        </Button>
      </div>
      {/* What each channel does, said before it is pressed: which file it writes, and that the file being
          read is not the one being written. */}
      <p className="text-[10px] text-text-300">{t('pdfAnnotation.export.annotatedHint')}</p>
      <p className="text-[10px] text-text-300">{t('pdfAnnotation.export.notesHint')}</p>
      {status()}
    </section>
  )
}

export const PdfAnnotationPanel = ({
  annotations,
  counts,
  anchor,
  loadError,
  onDelete,
  onReattach,
  pendingNote,
  noteBody,
  onNoteBodyChange,
  onNoteSave,
  onNoteCancel,
  importer,
  onImport,
  exporter,
  onExportAnnotated,
  onExportNotes,
  onClose
}: PdfAnnotationPanelProps): React.JSX.Element => {
  const { t } = useLanguage()
  const anchoredElsewhere = counts.versionChanged + counts.checksumMismatch

  return (
    <aside
      data-testid="pdf-annotation-panel"
      aria-label={t('pdfAnnotation.panel.title')}
      className="absolute right-0 top-0 z-20 flex h-full w-80 max-w-[85%] flex-col overflow-y-auto border-l border-border-300/50 bg-bg-000/95 backdrop-blur"
    >
      <header className="flex items-center justify-between gap-2 border-b border-border-300/40 px-3 py-2">
        <h2 className="text-[12px] font-medium text-text-000">{t('pdfAnnotation.panel.title')}</h2>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          data-slot="pdf-annotation-close"
          aria-label={t('pdfAnnotation.panel.close')}
          className="text-text-100 hover:text-text-000"
          onClick={onClose}
        >
          <X aria-hidden="true" />
        </Button>
      </header>

      <p
        data-testid="pdf-annotation-counts"
        data-current={counts.current}
        data-version-changed={counts.versionChanged}
        data-checksum-mismatch={counts.checksumMismatch}
        data-anchor-version={anchor?.versionId}
        data-anchor-checksum={anchor?.checksum}
        className="border-b border-border-300/40 px-3 py-2 text-[11px] text-text-200"
      >
        {t('pdfAnnotation.panel.counts', {
          current: counts.current,
          versionChanged: counts.versionChanged,
          checksumMismatch: counts.checksumMismatch
        })}
      </p>

      {/* The state that must never be silent: markup exists, and none of it is on the bytes on screen.
          Said once, above the list, with the handling path stated rather than implied. */}
      {counts.current === 0 && anchoredElsewhere > 0 ? (
        <p
          data-testid="pdf-annotation-version-notice"
          role="status"
          className="border-b border-border-300/40 bg-amber-500/10 px-3 py-2 text-[11px] text-text-100"
        >
          {t('pdfAnnotation.anchor.notice', { count: anchoredElsewhere })}
        </p>
      ) : null}

      {loadError ? (
        <p
          data-testid="pdf-annotation-load-error"
          role="alert"
          className="px-3 py-2 text-[11px] text-rose-500"
        >
          {t('pdfAnnotation.status.loadFailed', { message: loadError })}
        </p>
      ) : null}

      {pendingNote ? (
        <section
          data-testid="pdf-annotation-note-composer"
          className="space-y-1.5 border-b border-border-300/40 px-3 py-2"
        >
          <p className="text-[11px] text-text-100">
            {t('pdfAnnotation.note.page', { page: pendingNote.page })}
          </p>
          <textarea
            data-testid="pdf-annotation-note-input"
            aria-label={t('pdfAnnotation.note.page', { page: pendingNote.page })}
            className="h-16 w-full resize-none rounded border border-border-300/50 bg-bg-000 p-1.5 text-[11px] text-text-000 outline-none"
            placeholder={t('pdfAnnotation.note.placeholder')}
            value={noteBody}
            onChange={(event) => onNoteBodyChange(event.target.value)}
          />
          <div className="flex items-center gap-1.5">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-testid="pdf-annotation-note-save"
              className="h-7 px-2 text-[11px] text-text-100 hover:text-text-000"
              disabled={noteBody.trim() === ''}
              onClick={onNoteSave}
            >
              {t('pdfAnnotation.note.save')}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-testid="pdf-annotation-note-cancel"
              className="h-7 px-2 text-[11px] text-text-300 hover:text-text-000"
              onClick={onNoteCancel}
            >
              {t('pdfAnnotation.note.cancel')}
            </Button>
          </div>
        </section>
      ) : null}

      <ImportReport importer={importer} onImport={onImport} />

      {/* The two export channels sit beside the import: same read, opposite direction — and each one
          writes its own file or writes nothing at all. */}
      <ExportReport
        exporter={exporter}
        onExportAnnotated={onExportAnnotated}
        onExportNotes={onExportNotes}
      />

      {annotations.length === 0 ? (
        <p data-testid="pdf-annotation-empty" className="px-3 py-2 text-[11px] text-text-300">
          {t('pdfAnnotation.panel.empty')}
        </p>
      ) : (
        <ul className="divide-y divide-border-300/30">
          {annotations.map((view) => {
            const page = pageOf(view)
            const anchoredHere = view.anchorState === 'current'
            return (
              <li
                key={view.annotation.id}
                data-testid="pdf-annotation-item"
                data-kind={view.annotation.kind}
                data-anchor-state={view.anchorState}
                className="space-y-1 px-3 py-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] font-medium text-text-000">
                    {t(`pdfAnnotation.kind.${view.annotation.kind}` as TranslationKey)}
                    {page === undefined ? '' : ` · ${t('pdfAnnotation.item.page', { page })}`}
                  </span>
                  <span className="flex items-center gap-1">
                    {anchoredHere ? null : (
                      <span
                        data-testid="pdf-annotation-anchor-state"
                        className="rounded bg-amber-500/15 px-1 text-[10px] text-amber-700 dark:text-amber-300"
                      >
                        {view.anchorState === 'version-changed'
                          ? t('pdfAnnotation.anchor.versionChanged')
                          : t('pdfAnnotation.anchor.checksumMismatch')}
                      </span>
                    )}
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      data-testid="pdf-annotation-delete"
                      aria-label={t('pdfAnnotation.action.delete')}
                      className="text-text-300 hover:text-rose-500"
                      onClick={() => onDelete(view.annotation.id)}
                    >
                      <X aria-hidden="true" />
                    </Button>
                  </span>
                </div>

                <p className="whitespace-pre-wrap text-[11px] text-text-200 [overflow-wrap:anywhere]">
                  {quoteOf(view)}
                </p>

                {anchoredHere ? null : (
                  <div className="space-y-1">
                    <p className="text-[11px] text-text-300">
                      {view.anchorState === 'version-changed'
                        ? t('pdfAnnotation.anchor.versionChangedDetail', {
                            versionId: view.annotation.versionId
                          })
                        : t('pdfAnnotation.anchor.checksumMismatchDetail', {
                            versionId: view.annotation.versionId
                          })}
                    </p>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      data-testid="pdf-annotation-reattach"
                      className="h-7 px-2 text-[11px] text-text-100 hover:text-text-000"
                      onClick={() => onReattach(view.annotation.id)}
                    >
                      {t('pdfAnnotation.action.reattach')}
                    </Button>
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}

      {/* Stated once, at the bottom: the handling path the reader has, for the state they will hit. */}
      <p className="mt-auto px-3 py-2 text-[10px] text-text-300">
        {t('pdfAnnotation.anchor.keepHint')}
      </p>
    </aside>
  )
}
