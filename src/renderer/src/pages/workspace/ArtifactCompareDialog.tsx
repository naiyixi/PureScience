import { Dialog } from 'radix-ui'
import { AlertTriangle, ArrowUpDown, LoaderCircle, X } from 'lucide-react'
import { useEffect, useState } from 'react'

import { useLanguage } from '@/i18n'
import { Button } from '@/components/ui/button'
import {
  dialogCloseButtonClassName,
  dialogDescriptionClassName,
  dialogFooterClassName,
  dialogHeaderClassName,
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogTitleClassName
} from '@/components/ui/dialog-chrome'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import {
  createArtifactVersionLocator,
  type ArtifactVersionDescriptor
} from '../../../../shared/artifact-provenance'

import { diffArtifactText, type ArtifactDiffRow } from './artifact-line-diff'
import {
  ArtifactContentTooLargeError,
  formatVersionTimestamp,
  readArtifactFullText
} from './artifact-version-content'

type ArtifactCompareDialogProps = {
  open: boolean
  name: string
  projectId: string
  sessionId: string
  artifactId: string
  // Finalized Versions in ascending order; the dialog needs at least two.
  versions: ArtifactVersionDescriptor[]
  initialBaseVersionId?: string
  initialTargetVersionId?: string
  onClose: () => void
}

type CompareState =
  | { status: 'loading' }
  | { status: 'error'; tooLarge: boolean }
  | { status: 'ready'; diff: ReturnType<typeof diffArtifactText> }

const selectOptionLabel = (version: ArtifactVersionDescriptor): string =>
  `v${version.versionNumber} · ${formatVersionTimestamp(version.createdAt)}`

// Unified line diff between two finalized Versions of one artifact. Defaults to the selected
// Version against its immediate predecessor; both sides are freely re-selectable.
const ArtifactCompareDialog = ({
  open,
  name,
  projectId,
  sessionId,
  artifactId,
  versions,
  initialBaseVersionId,
  initialTargetVersionId,
  onClose
}: ArtifactCompareDialogProps): React.JSX.Element => {
  const { t } = useLanguage()

  const [baseVersionId, setBaseVersionId] = useState<string | undefined>()
  const [targetVersionId, setTargetVersionId] = useState<string | undefined>()
  const [state, setState] = useState<CompareState>({ status: 'loading' })

  // Each open re-seeds the pair from the caller's defaults (previous Version vs the one the user
  // was viewing) so a fresh open never inherits a stale selection.
  useEffect(() => {
    if (!open) return
    const current = versions
    let target =
      current.find((version) => version.versionId === initialTargetVersionId) ?? current.at(-1)
    let targetIndex = target ? current.indexOf(target) : -1
    // Callers normally pass a target with a finalized predecessor; a first-version target falls
    // back to the last pair rather than comparing a Version with itself.
    if (targetIndex === 0 && current.length > 1) {
      target = current.at(-1)
      targetIndex = current.length - 1
    }
    const base =
      current.find((version) => version.versionId === initialBaseVersionId) ??
      (targetIndex > 0
        ? current[targetIndex - 1]
        : current.length > 1
          ? current[current.length - 2]
          : undefined)
    if (!base || !target) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- open reseeds the pair
    setBaseVersionId(base.versionId)

    setTargetVersionId(target.versionId)
  }, [initialBaseVersionId, initialTargetVersionId, open])

  useEffect(() => {
    if (!open || !baseVersionId || !targetVersionId) return
    let canceled = false
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load()
    setState({ status: 'loading' })

    const locator = (versionId: string): string =>
      createArtifactVersionLocator({
        projectId,
        appSessionId: sessionId,
        artifactId,
        versionId
      })

    void Promise.all([
      readArtifactFullText({ projectId, sessionId, path: locator(baseVersionId) }),
      readArtifactFullText({ projectId, sessionId, path: locator(targetVersionId) })
    ])
      .then(([baseText, targetText]) => {
        if (canceled) return
        setState({ status: 'ready', diff: diffArtifactText(baseText, targetText) })
      })
      .catch((error: unknown) => {
        if (canceled) return
        setState({
          status: 'error',
          tooLarge: error instanceof ArtifactContentTooLargeError
        })
      })

    return () => {
      canceled = true
    }
  }, [artifactId, baseVersionId, open, projectId, sessionId, targetVersionId])

  const swap = (): void => {
    setBaseVersionId(targetVersionId)
    setTargetVersionId(baseVersionId)
  }

  const diffRowBackground = (kind: ArtifactDiffRow['kind']): string => {
    if (kind === 'added') {
      return 'bg-emerald-500/10 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
    }
    if (kind === 'removed') {
      return 'bg-red-500/10 text-red-700 dark:bg-red-950/40 dark:text-red-300'
    }
    return 'text-text-100'
  }
  const diffRowNumber = (kind: ArtifactDiffRow['kind']): string => {
    if (kind === 'added') return 'text-emerald-700 dark:text-emerald-300'
    if (kind === 'removed') return 'text-red-700 dark:text-red-300'
    return 'text-text-300'
  }

  const renderedDiff =
    state.status === 'ready' ? state.diff : { rows: [], additions: 0, deletions: 0, coarse: false }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={dialogOverlayClassName} />
        <Dialog.Content
          className={dialogPanelClassName(
            'flex max-h-[min(720px,calc(100vh-2rem))] w-[min(880px,calc(100vw-2rem))] flex-col'
          )}
        >
          <div className={dialogHeaderClassName}>
            <div className="min-w-0">
              <Dialog.Title className={dialogTitleClassName}>
                {t('artifactCompare.title')}
              </Dialog.Title>
              <Dialog.Description className={dialogDescriptionClassName}>{name}</Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className={dialogCloseButtonClassName}
                aria-label={t('common.close')}
              >
                <X className="size-4" aria-hidden="true" />
              </Button>
            </Dialog.Close>
          </div>

          <div className="mt-4 flex items-center gap-2">
            <Select
              value={baseVersionId ?? ''}
              onValueChange={(value) => setBaseVersionId(value || undefined)}
            >
              <SelectTrigger aria-label={t('artifactCompare.baseLabel')} className="h-8 w-48">
                <SelectValue placeholder={t('artifactCompare.baseLabel')} />
              </SelectTrigger>
              <SelectContent>
                {versions.map((version) => (
                  <SelectItem
                    key={version.versionId}
                    value={version.versionId}
                    disabled={version.versionId === targetVersionId}
                  >
                    {selectOptionLabel(version)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t('artifactCompare.swap')}
              onClick={swap}
            >
              <ArrowUpDown className="size-4" aria-hidden="true" />
            </Button>
            <Select
              value={targetVersionId ?? ''}
              onValueChange={(value) => setTargetVersionId(value || undefined)}
            >
              <SelectTrigger aria-label={t('artifactCompare.targetLabel')} className="h-8 w-48">
                <SelectValue placeholder={t('artifactCompare.targetLabel')} />
              </SelectTrigger>
              <SelectContent>
                {versions.map((version) => (
                  <SelectItem
                    key={version.versionId}
                    value={version.versionId}
                    disabled={version.versionId === baseVersionId}
                  >
                    {selectOptionLabel(version)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="ml-auto flex items-center gap-3 text-xs">
              {state.status === 'ready' ? (
                <>
                  <span
                    data-testid="compare-additions"
                    className="font-medium text-emerald-700 dark:text-emerald-300"
                  >
                    {t('artifactCompare.addedLineCount').replace(
                      '{n}',
                      String(state.diff.additions)
                    )}
                  </span>
                  <span className="text-text-300">·</span>
                  <span
                    data-testid="compare-deletions"
                    className="font-medium text-red-700 dark:text-red-300"
                  >
                    {t('artifactCompare.removedLineCount').replace(
                      '{n}',
                      String(state.diff.deletions)
                    )}
                  </span>
                </>
              ) : null}
            </div>
          </div>

          {state.status === 'loading' ? (
            <div className="flex min-h-72 flex-1 items-center justify-center gap-2 text-sm text-text-100">
              <LoaderCircle
                className="size-4 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
              {t('common.loading')}
            </div>
          ) : null}

          {state.status === 'error' ? (
            <div className="flex min-h-72 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
              <AlertTriangle className="size-6 text-warning-900" aria-hidden="true" />
              <p className="max-w-md text-sm leading-relaxed text-text-100">
                {state.tooLarge ? t('artifactCompare.tooLarge') : t('artifactCompare.loadFailed')}
              </p>
            </div>
          ) : null}

          {state.status === 'ready' ? (
            state.diff.coarse ? (
              <div className="mt-3 flex items-center gap-2 rounded-lg border border-warning-100/60 bg-warning-100/30 px-3 py-2 text-xs text-warning-900">
                <AlertTriangle className="size-3.5 shrink-0" aria-hidden="true" />
                {t('artifactCompare.tooLarge')}
              </div>
            ) : null
          ) : null}

          {state.status === 'ready' &&
          renderedDiff.rows.length > 0 &&
          state.diff.additions === 0 &&
          state.diff.deletions === 0 ? (
            <div
              data-testid="compare-no-changes"
              className="flex min-h-72 flex-1 flex-col items-center justify-center gap-2 text-sm text-text-100"
            >
              <span className="size-2 rounded-full bg-success-000" aria-hidden="true" />
              {t('artifactCompare.noChanges')}
            </div>
          ) : null}

          {state.status === 'ready' && (state.diff.additions > 0 || state.diff.deletions > 0) ? (
            <div
              data-testid="compare-diff"
              className="mt-3 min-h-0 flex-1 overflow-auto rounded-lg border border-border-200 bg-bg-100 py-1 font-mono text-[11px] leading-[1.7]"
            >
              {renderedDiff.rows.map((row, index) => (
                <div
                  key={index}
                  data-kind={row.kind}
                  className={cn('flex whitespace-pre px-2', diffRowBackground(row.kind))}
                >
                  <span
                    className={cn('w-7 shrink-0 select-none text-right', diffRowNumber(row.kind))}
                  >
                    {row.kind === 'added' ? row.afterLine : row.beforeLine}
                  </span>
                  <span className="w-4 shrink-0 select-none text-center">
                    {row.kind === 'added' ? '+' : row.kind === 'removed' ? '−' : ''}
                  </span>
                  <span className="min-w-0 flex-1">{row.text === '' ? ' ' : row.text}</span>
                </div>
              ))}
            </div>
          ) : null}

          <div className={dialogFooterClassName}>
            <Button type="button" variant="secondary" onClick={onClose}>
              {t('common.close')}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export { ArtifactCompareDialog }
