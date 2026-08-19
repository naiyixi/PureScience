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
        <AlertDialog.Content className={dialogPanelClassName('w-[min(440px,calc(100vw-2rem))]')}>
          <div className={dialogHeaderClassName}>
            <div className="min-w-0">
              <AlertDialog.Title className={dialogTitleClassName}>
                {t('home.deleteProjectTitle')}
              </AlertDialog.Title>
              <AlertDialog.Description className={dialogDescriptionClassName}>
                {t('home.deleteProjectConfirm').replace('{name}', dialogProject?.name ?? '')}
                {dialogHasCompleteSessionCatalog
                  ? dialogSessionCount > 0
                    ? ` and its ${dialogSessionCount} ${dialogSessionCount === 1 ? 'session' : 'sessions'}`
                    : ''
                  : ' and all of its saved conversations, including any that could not be loaded during recovery'}
                . Generated artifacts and uploaded files stored by PureScience will also be deleted.
                {t('home.deleteProjectHint')} be
                undone.
              </AlertDialog.Description>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Close"
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
                Cancel
              </Button>
            </AlertDialog.Cancel>
            {/* Async confirmation owns dialog closure so a failed deletion remains visible. */}
            <Button
              type="button"
              className={deleteDialogConfirmButtonClassName}
              disabled={!canDelete || isDeleting}
              onClick={onConfirmDelete}
            >
              {isDeleting ? 'Deleting…' : 'Delete'}
            </Button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}

export { DeleteProjectDialog }
