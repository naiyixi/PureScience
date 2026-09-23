import { useState } from 'react'
import { Package, X } from 'lucide-react'
import { Dialog } from 'radix-ui'

import { useLanguage } from '@/i18n'
import { Button } from '@/components/ui/button'
import {
  dialogCloseButtonClassName,
  dialogOverlayClassName,
  dialogPanelClassName
} from '@/components/ui/dialog-chrome'
import { useDialogFocusRestore } from '@/components/ui/dialog-focus-restore'
import { useRetainedDialogValue } from '@/components/ui/use-retained-dialog-value'
import type { ChatSession } from '@/stores/session-store'
import type {
  ExportSessionPackageFailure,
  SessionPackageMode,
  SessionPackageNoteCode
} from '../../../../shared/session-package'

// `sessions:export-package` had no renderer caller: the desktop could read a package someone else sent
// (the import dialog) but could not produce one of its own, so a session could only ever arrive, never
// leave. This is the missing half — and it is the same format in both directions, which is what makes
// the round trip checkable.
const FAILURE_KEYS = {
  cancelled: 'common.cancel',
  'session-not-found': 'sessions.packageExport.failure.session-not-found',
  'session-unreadable': 'sessions.packageExport.failure.session-unreadable',
  'no-destination': 'sessions.packageExport.failure.no-destination',
  'write-failed': 'sessions.packageExport.failure.write-failed'
} as const

// Note codes are `name` or `name:detail`. The detail is a path or a count the package named, so it is
// shown as itself rather than folded into prose; an unrecognised code is shown as the code, never
// swallowed into a generic apology.
const NOTE_KEYS: Record<string, string> = {
  'file-omitted-too-large': 'sessions.packageExport.note.file-omitted-too-large',
  'artifact-unreadable': 'sessions.packageExport.note.artifact-unreadable',
  'files-not-requested': 'sessions.packageExport.note.files-not-requested',
  'environment-lock-unavailable': 'sessions.packageExport.note.environment-lock-unavailable',
  'reproduction-outputs-unavailable':
    'sessions.packageExport.note.reproduction-outputs-unavailable',
  'reference-unreadable': 'sessions.packageExport.note.reference-unreadable',
  'reference-omitted-too-large': 'sessions.packageExport.note.reference-omitted-too-large',
  'reference-pdfs-not-requested': 'sessions.packageExport.note.reference-pdfs-not-requested'
}

type Translate = ReturnType<typeof useLanguage>['t']

const noteLabel = (note: SessionPackageNoteCode, t: Translate): string => {
  const separator = note.indexOf(':')
  const name = separator === -1 ? note : note.slice(0, separator)
  const detail = separator === -1 ? '' : note.slice(separator + 1)
  const key = NOTE_KEYS[name] as Parameters<Translate>[0] | undefined
  if (!key) return note
  const label = t(key)

  return detail === '' ? label : label.replace('{detail}', detail).replace('{count}', detail)
}

type SessionPackageExportDialogProps = {
  projectId: string
  /** `undefined` keeps the dialog closed; a session opens it. */
  session: ChatSession | undefined
  onClose: () => void
  onExported?: (path: string) => void
}

const SessionPackageExportDialog = ({
  projectId,
  session,
  onClose,
  onExported
}: SessionPackageExportDialogProps): React.JSX.Element => {
  const { t } = useLanguage()
  const dialogSession = useRetainedDialogValue(session)
  const [mode, setMode] = useState<SessionPackageMode>('essential')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<ExportSessionPackageFailure | undefined>(undefined)
  const [written, setWritten] = useState<
    { path: string; bytes: number; notes: readonly SessionPackageNoteCode[] } | undefined
  >(undefined)
  useDialogFocusRestore(Boolean(dialogSession))

  const handleExport = async (): Promise<void> => {
    if (!dialogSession) return
    setBusy(true)
    setFailure(undefined)
    setWritten(undefined)
    const result = await window.api.sessions.exportPackage({
      projectId,
      sessionId: dialogSession.id,
      mode
    })
    setBusy(false)
    if (!result.ok) {
      // A closed save sheet is a decision, not a failure — nothing is reported as one.
      if (result.error === 'cancelled') onClose()
      else setFailure(result.error)
      return
    }
    setWritten({ path: result.path, bytes: result.bytes, notes: result.notes })
    onExported?.(result.path)
  }

  return (
    <Dialog.Root
      // Open-ness follows the live prop; the retained value only keeps the content around while the
      // exit animation plays. Driving `open` off the retained value would leave the panel unclosable.
      open={Boolean(session)}
      onOpenChange={(open) => (open ? undefined : onClose())}
    >
      <Dialog.Overlay className={dialogOverlayClassName} />
      <Dialog.Content
        className={dialogPanelClassName('w-[26rem] max-w-[calc(100vw-2rem)]')}
        aria-label={t('sessions.packageExport.title')}
        onEscapeKeyDown={(event) => {
          event.preventDefault()
          onClose()
        }}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <Dialog.Title className="text-sm font-semibold text-foreground">
              {t('sessions.packageExport.title')}
            </Dialog.Title>
            <Dialog.Description className="mt-1 truncate text-xs text-muted-foreground">
              {dialogSession?.title ?? ''}
            </Dialog.Description>
          </div>
          <button
            type="button"
            className={dialogCloseButtonClassName}
            onClick={onClose}
            aria-label={t('common.close')}
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>

        <p className="mt-3 text-xs text-muted-foreground">
          {t('sessions.packageExport.description')}
        </p>

        <fieldset className="mt-3 space-y-2">
          <legend className="sr-only">{t('sessions.packageExport.modeLegend')}</legend>
          {(['essential', 'full'] as const).map((candidate) => (
            <label
              key={candidate}
              className="flex cursor-pointer items-start gap-2 rounded-md border border-border/60 p-2 text-xs hover:bg-accent/40"
            >
              <input
                type="radio"
                name="session-package-mode"
                value={candidate}
                checked={mode === candidate}
                disabled={busy}
                onChange={() => setMode(candidate)}
                className="mt-0.5"
              />
              <span className="min-w-0">
                <span className="block font-medium text-foreground">
                  {candidate === 'essential'
                    ? t('sessions.packageExport.modeEssential')
                    : t('sessions.packageExport.modeFull')}
                </span>
                <span className="block text-muted-foreground">
                  {candidate === 'essential'
                    ? t('sessions.packageExport.modeEssentialHint')
                    : t('sessions.packageExport.modeFullHint')}
                </span>
              </span>
            </label>
          ))}
        </fieldset>

        {failure !== undefined ? (
          <p
            role="alert"
            data-testid="package-export-failure"
            className="mt-3 text-xs text-destructive"
          >
            {t(FAILURE_KEYS[failure])}
          </p>
        ) : null}

        {written !== undefined ? (
          <div data-testid="package-export-result" className="mt-3 text-xs text-muted-foreground">
            <p className="text-primary">
              {t('sessions.packageExport.done')
                .replace('{name}', written.path.split(/[/\\]/).pop() ?? written.path)
                .replace('{size}', String(Math.max(1, Math.round(written.bytes / 1024))))}
            </p>
            {written.notes.length > 0 ? (
              <div className="mt-1">
                <p className="font-medium">{t('sessions.packageExport.notesLabel')}</p>
                <ul className="mt-0.5 list-disc space-y-0.5 pl-4">
                  {written.notes.map((note) => (
                    <li key={note}>{noteLabel(note, t)}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button
            type="button"
            size="sm"
            data-testid="package-export-submit"
            disabled={busy || !dialogSession}
            onClick={() => void handleExport()}
          >
            <Package aria-hidden="true" />
            {busy ? t('common.exporting') : t('sessions.packageExport.export')}
          </Button>
        </div>
      </Dialog.Content>
    </Dialog.Root>
  )
}

export { SessionPackageExportDialog }
