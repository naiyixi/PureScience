import { useLanguage } from '@/i18n'
import { X } from 'lucide-react'
import { AlertDialog } from 'radix-ui'

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
import { useRetainedDialogValue } from '@/components/ui/use-retained-dialog-value'
import type { Project } from '../../../../shared/projects'
import { useDialogFocusRestore } from '@/components/ui/dialog-focus-restore'

type DeleteProjectDialogProps = {
  project: Project | undefined
  sessionCount: number
  hasCompleteSessionCatalog: boolean
  canDelete: boolean
  isDeleting: boolean
  error: string | undefined
  onCancel: () => void
  onConfirmDelete: () => void
}

const deleteDialogConfirmButtonClassName =
  'border-transparent bg-danger-000 text-white hover:bg-danger-000/90 hover:text-white'

// Destructive deletion requires confirmation and reports the app-managed data removed with the Project.
const DeleteProjectDialog = ({
  project,
  sessionCount,
  hasCompleteSessionCatalog,
  canDelete,
  isDeleting,
  error,
  onCancel,
  onConfirmDelete
}: DeleteProjectDialogProps): React.JSX.Element => {
  const { t } = useLanguage()
  const focusRestore = useDialogFocusRestore(Boolean(project))
  const dialogProject = useRetainedDialogValue(project)
  const dialogSessionCount =
    useRetainedDialogValue(project ? sessionCount : undefined) ?? sessionCount
  const dialogHasCompleteSessionCatalog =
    useRetainedDialogValue(project ? hasCompleteSessionCatalog : undefined) ??
    hasCompleteSessionCatalog

  return (
    <AlertDialog.Root
      open={Boolean(project)}
      onOpenChange={(open) => {
        if (!open && !isDeleting) onCancel()
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Overlay className={dialogOverlayClassName} />
        <AlertDialog.Content
          className={dialogPanelClassName('w-[min(440px,calc(100vw-2rem))]')}
          onOpenAutoFocus={focusRestore.onOpenAutoFocus}
          onCloseAutoFocus={focusRestore.onCloseAutoFocus}
        >
          <div className={dialogHeaderClassName}>
            <div className="min-w-0">
              <AlertDialog.Title className={dialogTitleClassName}>
                {t('home.deleteProjectTitle')}
              </AlertDialog.Title>
              <AlertDialog.Description className={dialogDescriptionClassName}>
                {t('home.deleteProjectConfirm', { name: dialogProject?.name ?? '' })}
                {dialogHasCompleteSessionCatalog
                  ? dialogSessionCount > 0
                    ? ` ${t(
                        dialogSessionCount === 1
                          ? 'home.deleteProjectOneSession'
                          : 'home.deleteProjectSessions',
                        { count: dialogSessionCount }
                      )}`
                    : ''
                  : ` ${t('home.deleteProjectUnloadedSessions')}`}{' '}
                {t('home.deleteProjectManagedData')} {t('home.deleteProjectHint')}
              </AlertDialog.Description>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t('common.close')}
              className={dialogCloseButtonClassName}
              disabled={isDeleting}
              onClick={onCancel}
            >
              <X className="size-4" aria-hidden="true" />
            </Button>
          </div>
          {error ? (
            <p className="mt-4 text-sm text-danger-000" role="alert">
              {error}
            </p>
          ) : null}
          <div className={dialogFooterClassName}>
            <AlertDialog.Cancel asChild>
              <Button type="button" variant="outline" disabled={isDeleting}>
                {t('common.cancel')}
              </Button>
            </AlertDialog.Cancel>
            {/* Async confirmation owns dialog closure so a failed deletion remains visible. */}
            <Button
              type="button"
              className={deleteDialogConfirmButtonClassName}
              disabled={!canDelete || isDeleting}
              onClick={onConfirmDelete}
            >
              {isDeleting ? t('common.deleting') : t('common.delete')}
            </Button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}

export { DeleteProjectDialog }
