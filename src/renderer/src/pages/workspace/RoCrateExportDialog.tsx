import { useState } from 'react'
import { Boxes, X } from 'lucide-react'
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
import type { RoCrateExportFailure, RoCrateExportSuccess } from '../../../../shared/ro-crate-export'

// `ro-crate:export-project` is the desktop half of the RO-Crate export: the writer already builds a
// crate and refuses its own output if it does not validate, but until a window can call it the export
// exists only for tests. This is the caller — and it reports what a caller can actually check: where
// the crate landed, how many files it holds, and the validation verdict, rather than a bare "done".
//
// A refusal is shown by its NAME (the code main returned). "Something went wrong" would leave the
// person with no next step; "no published version yet" and "every version was refused because its
// bytes no longer matched" are different problems with different answers.
const FAILURE_KEYS = {
  cancelled: 'common.cancel',
  'project-not-found': 'roCrate.export.failure.project-not-found',
  'no-published-version': 'roCrate.export.failure.no-published-version',
  'no-exportable-version': 'roCrate.export.failure.no-exportable-version',
  'destination-unwritable': 'roCrate.export.failure.destination-unwritable',
  'validation-failed': 'roCrate.export.failure.validation-failed',
  'write-failed': 'roCrate.export.failure.write-failed'
} as const

type RoCrateExportDialogProps = {
  projectId: string
  projectName: string
  /** `undefined` keeps the dialogue closed; the active project opens it. */
  open: boolean
  onClose: () => void
}

const RoCrateExportDialog = ({
  projectId,
  projectName,
  open,
  onClose
}: RoCrateExportDialogProps): React.JSX.Element => {
  const { t } = useLanguage()
  // Open-ness follows the live prop; the retained value only keeps the title around while the exit
  // animation plays.
  const retainedName = useRetainedDialogValue(open ? projectName : undefined)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<RoCrateExportFailure | undefined>(undefined)
  const [written, setWritten] = useState<RoCrateExportSuccess | undefined>(undefined)
  useDialogFocusRestore(open)

  const handleExport = async (): Promise<void> => {
    if (projectId === '') return
    setBusy(true)
    setFailure(undefined)
    setWritten(undefined)
    const result = await window.api.roCrate.exportProject({ projectId })
    setBusy(false)
    if (!result.ok) {
      // A closed save sheet is a decision, not a failure — nothing is reported as one.
      if (result.error === 'cancelled') onClose()
      else setFailure(result.error)
      return
    }
    setWritten(result)
  }

  return (
    <Dialog.Root open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <Dialog.Overlay className={dialogOverlayClassName} />
      <Dialog.Content
        className={dialogPanelClassName('w-[28rem] max-w-[calc(100vw-2rem)]')}
        aria-label={t('roCrate.export.title')}
        onEscapeKeyDown={(event) => {
          event.preventDefault()
          onClose()
        }}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <Dialog.Title className="text-sm font-semibold text-foreground">
              {t('roCrate.export.title')}
            </Dialog.Title>
            <Dialog.Description className="mt-1 truncate text-xs text-muted-foreground">
              {retainedName ?? ''}
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

        <p className="mt-3 text-xs text-muted-foreground">{t('roCrate.export.description')}</p>

        {failure !== undefined ? (
          <p
            role="alert"
            data-testid="ro-crate-export-failure"
            className="mt-3 text-xs text-destructive"
          >
            {t(FAILURE_KEYS[failure])}
          </p>
        ) : null}

        {written !== undefined ? (
          <div
            data-testid="ro-crate-export-result"
            className="mt-3 space-y-1 text-xs text-muted-foreground"
          >
            <p className="break-words text-primary">
              {t('roCrate.export.done')
                .replace('{count}', String(written.fileCount))
                .replace('{path}', written.outputDir)}
            </p>
            <p data-testid="ro-crate-export-validation">
              {t('roCrate.export.validated').replace('{passed}', String(written.validation.passed))}
            </p>
            {written.refusedCount > 0 ? (
              <p data-testid="ro-crate-export-refused">
                {t('roCrate.export.refused').replace('{count}', String(written.refusedCount))}
              </p>
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
            data-testid="ro-crate-export-submit"
            disabled={busy || projectId === ''}
            onClick={() => void handleExport()}
          >
            <Boxes aria-hidden="true" />
            {busy ? t('common.exporting') : t('roCrate.export.export')}
          </Button>
        </div>
      </Dialog.Content>
    </Dialog.Root>
  )
}

export { RoCrateExportDialog }
