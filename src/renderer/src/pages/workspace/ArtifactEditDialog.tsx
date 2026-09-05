import { Dialog } from 'radix-ui'
import { AlertTriangle, LoaderCircle, X } from 'lucide-react'
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
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import type { ArtifactFile } from '../../../../shared/artifacts'

import { ArtifactContentTooLargeError, readArtifactFullText } from './artifact-version-content'

type ArtifactEditDialogProps = {
  open: boolean
  name: string
  versionNumber: number
  projectId: string
  // App session that owns the artifact lineage; the edited content publishes into that lineage.
  sessionId: string
  // Storage session for the pending-file transaction (equals the artifact owner session today).
  storageSessionId: string
  // Immutable source Version; the edit never mutates it, only appends after it.
  sourceVersionId: string
  // Version locator path used to load the current full text.
  path: string
  contentType?: string
  // Code/JSON artifacts edit in a monospace surface; prose formats use the proportional editor.
  monospace?: boolean
  onClose: () => void
  // The finalized Artifact Version returned by the main-process write.
  onSaved: (version: ArtifactFile) => void
}

type EditSurface =
  | { phase: 'loading' }
  | { phase: 'error'; tooLarge: boolean }
  | { phase: 'ready'; originalContent: string }

// Publisher for one immutable Version from a user edit. Loads the selected Version's full text,
// lets the user revise it, and saves through writeUserEditedVersion — the main process appends a
// NEW finalized Version in the same lineage and leaves the source Version untouched.
const ArtifactEditDialog = ({
  open,
  name,
  versionNumber,
  projectId,
  sessionId,
  storageSessionId,
  sourceVersionId,
  path,
  contentType,
  monospace = false,
  onClose,
  onSaved
}: ArtifactEditDialogProps): React.JSX.Element => {
  const { t } = useLanguage()
  const [surface, setSurface] = useState<EditSurface>({ phase: 'loading' })
  const [content, setContent] = useState('')
  const [confirmingDiscard, setConfirmingDiscard] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveFailed, setSaveFailed] = useState(false)

  const dirty = surface.phase === 'ready' && (content !== surface.originalContent || saveFailed)

  useEffect(() => {
    if (!open) return
    let canceled = false
    // eslint-disable-next-line react-hooks/set-state-in-effect -- open reseeds the editor
    setSurface({ phase: 'loading' })

    setContent('')

    setConfirmingDiscard(false)

    setSaveFailed(false)

    void readArtifactFullText({ projectId, sessionId, path, source: 'artifact' })
      .then((text) => {
        if (!canceled) {
          setContent(text)
          setSurface({ phase: 'ready', originalContent: text })
        }
      })
      .catch((error: unknown) => {
        if (!canceled) {
          setSurface({
            phase: 'error',
            tooLarge: error instanceof ArtifactContentTooLargeError
          })
        }
      })

    return () => {
      canceled = true
    }
  }, [open, path, projectId, sessionId])

  const requestClose = (): void => {
    if (saving) return
    if (dirty) {
      setConfirmingDiscard(true)
      return
    }
    onClose()
  }

  const handleOpenChange = (nextOpen: boolean): void => {
    if (!nextOpen) requestClose()
  }

  const handleSave = async (): Promise<void> => {
    if (surface.phase !== 'ready' || saving) return
    setSaving(true)
    setSaveFailed(false)
    try {
      const version = await window.api.artifacts.writeUserEditedVersion({
        projectId,
        appSessionId: sessionId,
        artifactStorageSessionId: storageSessionId,
        sourceVersionId,
        content,
        ...(contentType ? { contentType } : {})
      })
      // Keep the internal state non-dirty while the parent closes the dialog over the new Version.
      setContent('')
      onSaved(version)
    } catch {
      setSaveFailed(true)
    } finally {
      setSaving(false)
    }
  }

  const publishHint = t('artifactEdit.publishHint').replace('{version}', String(versionNumber))

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={dialogOverlayClassName} />
        <Dialog.Content
          className={dialogPanelClassName(
            'flex max-h-[min(720px,calc(100vh-2rem))] w-[min(860px,calc(100vw-2rem))] flex-col'
          )}
        >
          <div className={dialogHeaderClassName}>
            <div className="min-w-0">
              <Dialog.Title className={dialogTitleClassName}>
                {t('artifactEdit.title')}
              </Dialog.Title>
              <Dialog.Description className={dialogDescriptionClassName}>
                <span className="font-medium text-foreground">{name}</span>
                {` · ${publishHint}`}
              </Dialog.Description>
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

          {surface.phase === 'loading' ? (
            <div className="flex min-h-56 flex-1 items-center justify-center gap-2 text-sm text-text-100">
              <LoaderCircle
                className="size-4 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
              {t('common.loading')}
            </div>
          ) : null}

          {surface.phase === 'error' ? (
            <div className="flex min-h-56 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
              <AlertTriangle className="size-6 text-warning-900" aria-hidden="true" />
              <p className="max-w-md text-sm leading-relaxed text-text-100">
                {surface.tooLarge ? t('artifactEdit.tooLarge') : t('artifactEdit.loadFailed')}
              </p>
            </div>
          ) : null}

          {surface.phase === 'ready' && !confirmingDiscard ? (
            <div className="mt-4 flex min-h-0 flex-1 flex-col">
              <Textarea
                className={cn(
                  'min-h-0 flex-1 resize-none rounded-lg border border-border-200 bg-bg-100 px-3 py-2.5 leading-5 text-text-000 focus:outline-none focus:ring-1 focus:ring-primary/50',
                  monospace ? 'font-mono text-[12px]' : 'text-[13px]'
                )}
                aria-label={t('artifactEdit.contentAria')}
                spellCheck={false}
                value={content}
                disabled={saving}
                onChange={(event) => setContent(event.target.value)}
              />
              {saveFailed ? (
                <p className="mt-2 flex items-center gap-1.5 text-xs text-danger-000" role="alert">
                  <AlertTriangle className="size-3.5" aria-hidden="true" />
                  {t('artifactEdit.saveFailed')}
                </p>
              ) : null}
            </div>
          ) : null}

          {surface.phase === 'ready' && confirmingDiscard ? (
            <div className="flex min-h-56 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
              <AlertTriangle className="size-6 text-warning-900" aria-hidden="true" />
              <p className="max-w-md text-sm leading-relaxed text-text-100">
                {t('artifactEdit.discardPrompt')}
              </p>
            </div>
          ) : null}

          <div className={dialogFooterClassName}>
            {surface.phase === 'ready' && confirmingDiscard ? (
              <>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => setConfirmingDiscard(false)}
                >
                  {t('artifactEdit.discardKeep')}
                </Button>
                <Button type="button" variant="destructive" onClick={onClose}>
                  {t('artifactEdit.discardAction')}
                </Button>
              </>
            ) : (
              <>
                <Button type="button" variant="secondary" onClick={requestClose}>
                  {t('common.cancel')}
                </Button>
                <Button type="button" disabled={!dirty || saving} onClick={() => void handleSave()}>
                  {saving ? t('common.saving') : t('common.save')}
                </Button>
              </>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export { ArtifactEditDialog }
