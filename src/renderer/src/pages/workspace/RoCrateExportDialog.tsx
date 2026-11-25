import { useState } from 'react'
import { Boxes, FolderOpen, Search, X } from 'lucide-react'
import { Dialog } from 'radix-ui'

import { useLanguage } from '@/i18n'
import type { TranslationKey } from '@/i18n'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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
import { failedRoCrateAssertions, type RoCrateAssertion } from '../../../../shared/ro-crate'
import type {
  ExternalRoCrateRefusal,
  RoCrateInspectResult
} from '../../../../shared/ro-crate-inspect'

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

// The three ways a folder fails before any rule is judged, named like the export refusals are: the reader
// gets the problem, not an apology. Kept in sync with the shared list by the type below — a fourth refusal
// code would fail to compile here rather than reach the screen as a bare token.
const INSPECT_REFUSAL_KEYS = {
  'no-metadata-file': 'roCrate.inspect.failure.no-metadata-file',
  unreadable: 'roCrate.inspect.failure.unreadable',
  unparseable: 'roCrate.inspect.failure.unparseable'
} as const satisfies Record<ExternalRoCrateRefusal, string>

// A failed check is reported with the LEVEL it failed at, because the levels mean different things: a
// `spec-must` miss is a crate that breaks RO-Crate 1.1, while an `export-contract` miss is a crate that is
// not one of this app's own exports. Printing them as one list without that word would tell an external
// crate's author that their file is wrong when it never claimed to be ours.
const ASSERTION_LEVEL_KEYS = {
  'spec-must': 'roCrate.inspect.level.spec-must',
  'spec-should': 'roCrate.inspect.level.spec-should',
  'export-contract': 'roCrate.inspect.level.export-contract'
} as const satisfies Record<RoCrateAssertion['level'], string>

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

/** One row per check that was not met. The rule's own code comes first and its level names what kind of
 * claim it is; the reader's detail follows on its own line, because a rule name alone still leaves the
 * crate's author without the value that failed. */
const FailedChecks = ({
  failed,
  t
}: {
  failed: readonly RoCrateAssertion[]
  t: (key: TranslationKey) => string
}): React.JSX.Element => (
  <ul data-testid="ro-crate-inspect-failed-list" className="mt-1 space-y-1.5 text-muted-foreground">
    {failed.map((assertion) => (
      <li key={assertion.id} className="break-words">
        <span className="font-mono text-foreground">{assertion.id}</span>
        <span className="ml-1">· {t(ASSERTION_LEVEL_KEYS[assertion.level])}</span>
        {assertion.detail ? (
          <span className="mt-0.5 block font-mono text-[0.7rem] break-words">
            {assertion.detail}
          </span>
        ) : null}
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
  // The read-only half. The folder is typed or picked (the native folder dialogue is the existing storage
  // picker, so cancelling it simply leaves the field as it was), and the answer — refusal or report — is
  // kept whole: the report's failed checks are what the surface shows.
  const [cratePath, setCratePath] = useState('')
  const [inspecting, setInspecting] = useState(false)
  const [inspection, setInspection] = useState<RoCrateInspectResult | undefined>(undefined)
  useDialogFocusRestore(open)

  const handleChooseFolder = async (): Promise<void> => {
    const picked = await window.api.storage.pickDirectory()
    if (!picked) return
    setCratePath(picked)
    setInspection(undefined)
  }

  const handleInspect = async (): Promise<void> => {
    const path = cratePath.trim()
    if (path === '') return
    setInspecting(true)
    setInspection(undefined)
    const result = await window.api.roCrate.inspectExternal({ cratePath: path })
    setInspecting(false)
    setInspection(result)
  }
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
        className={dialogPanelClassName(
          // The panel now carries two jobs (write a crate, check a foreign one). On a short window the
          // footer buttons are the first thing to fall off the bottom, so the panel itself scrolls rather
          // than the content growing past the viewport.
          'w-[28rem] max-w-[calc(100vw-2rem)] max-h-[calc(100vh-4rem)] overflow-y-auto'
        )}
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
        {/* What this surface does with a crate from elsewhere is said here rather than left to be
            discovered: a foreign crate can be CHECKED (read-only, below) and is never imported into a
            project. "Passed" is deliberately narrow — see the note beside the check. */}
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

        {/* --- the read-only half: a crate this app did NOT write ---------------------------------------
            The rules are the app's own (`validateRoCrate`) and they are applied to a foreign crate by
            reading its metadata document — nothing is written into the folder, nothing is imported. The
            folder comes from the field or from the existing storage folder picker, so a cancelled picker
            never reaches the reader. */}
        <div className="mt-4 border-t border-border pt-3" data-slot="ro-crate-inspect">
          <p className="text-sm font-semibold text-foreground">{t('roCrate.inspect.heading')}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t('roCrate.inspect.scopeNote')}</p>
          <label
            htmlFor="ro-crate-inspect-path-input"
            className="mt-2 block text-xs font-medium text-muted-foreground"
          >
            {t('roCrate.inspect.pathLabel')}
          </label>
          <div className="mt-1 flex gap-2">
            <Input
              id="ro-crate-inspect-path-input"
              data-slot="ro-crate-inspect-path"
              type="text"
              value={cratePath}
              disabled={inspecting}
              onChange={(event) => {
                setCratePath(event.target.value)
                setInspection(undefined)
              }}
              className="flex-1 bg-background font-mono"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="ro-crate-inspect-choose"
              disabled={inspecting}
              onClick={() => void handleChooseFolder()}
            >
              <FolderOpen aria-hidden="true" />
              {t('roCrate.inspect.chooseFolder')}
            </Button>
          </div>
          <div className="mt-2 flex justify-end">
            <Button
              type="button"
              size="sm"
              data-testid="ro-crate-inspect-submit"
              disabled={inspecting || cratePath.trim() === ''}
              onClick={() => void handleInspect()}
            >
              <Search aria-hidden="true" />
              {inspecting ? t('roCrate.inspect.running') : t('roCrate.inspect.run')}
            </Button>
          </div>

          {inspection !== undefined ? (
            inspection.ok ? (
              <div
                data-testid="ro-crate-inspect-result"
                className="mt-2 space-y-1 text-xs text-muted-foreground"
              >
                <p data-testid="ro-crate-inspect-summary">
                  {t('roCrate.inspect.summary')
                    .replace('{passed}', String(inspection.report.passed))
                    .replace('{total}', String(inspection.report.assertions.length))
                    .replace('{failed}', String(inspection.report.failed))}
                </p>
                {/* Which document produced the report. A path is a path in every language, so it is not
                    a translated string — and without it a reader cannot tell two crates apart. */}
                <p
                  data-testid="ro-crate-inspect-metadata-path"
                  className="font-mono text-[0.7rem] break-words"
                >
                  {inspection.metadataPath}
                </p>
                {inspection.report.failed > 0 ? (
                  <>
                    <p className="mt-1 font-medium text-foreground">
                      {t('roCrate.inspect.failedHeading')}
                    </p>
                    <FailedChecks failed={failedRoCrateAssertions(inspection.report)} t={t} />
                  </>
                ) : (
                  <p data-testid="ro-crate-inspect-all-passed">{t('roCrate.inspect.allPassed')}</p>
                )}
              </div>
            ) : (
              <div className="mt-2 space-y-1 text-xs">
                <p role="alert" data-testid="ro-crate-inspect-failure" className="text-destructive">
                  {t(INSPECT_REFUSAL_KEYS[inspection.error])}
                </p>
                {inspection.detail ? (
                  <p
                    data-testid="ro-crate-inspect-failure-detail"
                    className="max-h-32 overflow-y-auto font-mono text-[0.7rem] break-words text-muted-foreground"
                  >
                    {inspection.detail}
                  </p>
                ) : null}
              </div>
            )
          ) : null}
        </div>

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
