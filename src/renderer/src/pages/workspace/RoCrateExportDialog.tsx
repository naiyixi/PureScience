import { useState } from 'react'
import { Boxes, X } from 'lucide-react'
import { Dialog } from 'radix-ui'

import { useLanguage } from '@/i18n'
import type { TranslationKey } from '@/i18n'
import { Button } from '@/components/ui/button'
import {
  dialogCloseButtonClassName,
  dialogOverlayClassName,
  dialogPanelClassName
} from '@/components/ui/dialog-chrome'
import { useDialogFocusRestore } from '@/components/ui/dialog-focus-restore'
import { useRetainedDialogValue } from '@/components/ui/use-retained-dialog-value'
import type {
  RoCrateExportRefusal,
  RoCrateExportRefusedVersion,
  RoCrateExportSuccess
} from '../../../../shared/ro-crate-export'

// `ro-crate:export-project` is the desktop half of the RO-Crate export: the writer already builds a
// crate and refuses its own output if it does not validate, but until a window can call it the export
// exists only for tests. This is the caller — and it reports what a caller can actually check: where
// the crate landed, how many files it holds, and the validation verdict, rather than a bare "done".
//
// A refusal is shown by its NAME (the code main returned). "Something went wrong" would leave the
// person with no next step; "no published version yet" and "every version was refused because its
// bytes no longer matched" are different problems with different answers.
//
// Naming it is the first line, not the whole answer: the writer already says WHICH Versions it refused
// and why, and — when it failed its own assertions — which requirement was not met. Those are read here
// rather than dropped. `detail` is free text from the writer, so it is shown UNDER the named refusal and
// never as the only thing on screen.
const FAILURE_KEYS = {
  cancelled: 'common.cancel',
  'project-not-found': 'roCrate.export.failure.project-not-found',
  'no-published-version': 'roCrate.export.failure.no-published-version',
  'no-exportable-version': 'roCrate.export.failure.no-exportable-version',
  'destination-unwritable': 'roCrate.export.failure.destination-unwritable',
  'validation-failed': 'roCrate.export.failure.validation-failed',
  'write-failed': 'roCrate.export.failure.write-failed'
} as const

const REFUSAL_REASON_KEYS = {
  'evidence-unreadable': 'roCrate.export.refusal.evidence-unreadable',
  'evidence-invalid': 'roCrate.export.refusal.evidence-invalid',
  'content-missing': 'roCrate.export.refusal.content-missing',
  'checksum-mismatch': 'roCrate.export.refusal.checksum-mismatch'
} as const satisfies Record<RoCrateExportRefusedVersion['reason'], string>

type RoCrateExportDialogProps = {
  projectId: string
  projectName: string
  /** `undefined` keeps the dialogue closed; the active project opens it. */
  open: boolean
  onClose: () => void
}

/** One line per refused Version: the record it came from, and why its bytes did not make it in. */
const RefusedList = ({
  refused,
  t,
  testId
}: {
  refused: readonly RoCrateExportRefusedVersion[]
  t: (key: TranslationKey) => string
  testId: string
}): React.JSX.Element => (
  <ul data-testid={testId} className="space-y-1 text-muted-foreground">
    {refused.map((entry) => (
      <li key={entry.versionId} className="break-words">
        {t('roCrate.export.refusedEntry')
          .replace('{version}', entry.versionId)
          .replace('{reason}', t(REFUSAL_REASON_KEYS[entry.reason]))}
      </li>
    ))}
  </ul>
)

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
  // The whole refusal is kept, not only its code: the named reason and the evidence behind it are the
  // same answer, and the writer already put both on the wire.
  const [failure, setFailure] = useState<RoCrateExportRefusal | undefined>(undefined)
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
      else setFailure(result)
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
        {/* What this surface does NOT do is said here rather than left to be discovered: the crate
            validator exists and is applied to everything this app writes, but a crate from elsewhere has
            no way in — no import, and therefore no validation of a foreign crate. */}
        <p className="mt-1 text-xs text-muted-foreground" data-slot="ro-crate-export-only">
          {t('roCrate.export.exportOnly')}
        </p>

        {failure !== undefined ? (
          <div className="mt-3 space-y-1 text-xs">
            <p role="alert" data-testid="ro-crate-export-failure" className="text-destructive">
              {t(FAILURE_KEYS[failure.error])}
            </p>
            {failure.detail ? (
              <p
                data-testid="ro-crate-export-failure-detail"
                className="max-h-32 overflow-y-auto break-words text-[0.7rem] text-muted-foreground"
              >
                {failure.detail}
              </p>
            ) : null}
            {failure.refused && failure.refused.length > 0 ? (
              <RefusedList refused={failure.refused} t={t} testId="ro-crate-export-refused-list" />
            ) : null}
          </div>
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
            {written.refused.length > 0 ? (
              <>
                <p data-testid="ro-crate-export-refused">
                  {t('roCrate.export.refused').replace('{count}', String(written.refusedCount))}
                </p>
                <RefusedList
                  refused={written.refused}
                  t={t}
                  testId="ro-crate-export-refused-list-success"
                />
              </>
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
