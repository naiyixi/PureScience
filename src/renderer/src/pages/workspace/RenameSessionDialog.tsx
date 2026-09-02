import { X } from 'lucide-react'
import { Dialog } from 'radix-ui'

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
import { useRetainedDialogValue } from '@/components/ui/use-retained-dialog-value'
import { Input } from '@/components/ui/input'
import type { ChatSession } from '@/stores/session-store'

type RenameSessionDialogProps = {
  session: ChatSession | undefined
  renameDraft: string
  descriptionDraft: string
  onRenameDraftChange: (value: string) => void
  onDescriptionDraftChange: (value: string) => void
  onCancel: () => void
  onConfirmRename: (event: React.FormEvent<HTMLFormElement>) => void
}

const renameDialogInputClassName =
  'h-9 rounded-lg border-border bg-card px-3 text-sm text-foreground shadow-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/25'

// Rename dialog updates only the session title; messages and run status stay untouched.
const RenameSessionDialog = ({
  session,
  renameDraft,
  descriptionDraft,
  onRenameDraftChange,
  onDescriptionDraftChange,
  onCancel,
  onConfirmRename
}: RenameSessionDialogProps): React.JSX.Element => {
  const { t } = useLanguage()
  const dialogRenameDraft = useRetainedDialogValue(session ? renameDraft : undefined) ?? renameDraft

  return (
    <Dialog.Root
      open={Boolean(session)}
      onOpenChange={(open) => {
        if (open) return

        onCancel()
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={dialogOverlayClassName} />
        <Dialog.Content
          onInteractOutside={(event) => event.preventDefault()}
          className={dialogPanelClassName('w-[min(420px,calc(100vw-2rem))]')}
        >
          <form onSubmit={onConfirmRename}>
            <div className={dialogHeaderClassName}>
              <div className="min-w-0">
                <Dialog.Title className={dialogTitleClassName}>
                  {t('renameSession.title')}
                </Dialog.Title>
                <Dialog.Description className={dialogDescriptionClassName}>
                  {t('renameSession.hint')}
                </Dialog.Description>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Close"
                className={dialogCloseButtonClassName}
                onClick={onCancel}
              >
                <X className="size-4" aria-hidden="true" />
              </Button>
            </div>
            <div className="mt-4 space-y-3">
              <Input
                value={dialogRenameDraft}
                onChange={(event) => onRenameDraftChange(event.target.value)}
                aria-label={t('renameSession.name')}
                autoFocus
                className={renameDialogInputClassName}
              />
              <textarea
                value={descriptionDraft}
                onChange={(event) => onDescriptionDraftChange(event.target.value)}
                aria-label={t('renameSession.description')}
                rows={3}
                maxLength={240}
                placeholder={t('renameSession.purposePlaceholder')}
                className={`w-full resize-none rounded-lg border-border bg-card px-3 py-2 text-sm text-foreground shadow-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/25 ${renameDialogInputClassName}`}
              />
            </div>
            <div className={dialogFooterClassName}>
              <Button type="button" variant="outline" onClick={onCancel}>
                Cancel
              </Button>
              <Button type="submit" disabled={dialogRenameDraft.trim().length === 0}>
                Rename
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export { RenameSessionDialog }
