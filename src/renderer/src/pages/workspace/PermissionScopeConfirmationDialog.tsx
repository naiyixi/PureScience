import { AlertDialog } from 'radix-ui'

import { useLanguage } from '@/i18n'

import { Button } from '@/components/ui/button'
import {
  dialogDescriptionClassName,
  dialogFooterClassName,
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogTitleClassName
} from '@/components/ui/dialog-chrome'
import { useRetainedDialogValue } from '@/components/ui/use-retained-dialog-value'

type BroadPermissionScope = 'project' | 'global'

type PermissionScopeConfirmation = {
  scope: BroadPermissionScope
  subject: string
  codeExecution: boolean
}

type PermissionScopeConfirmationDialogProps = {
  confirmation: PermissionScopeConfirmation | undefined
  onCancel: () => void
  onConfirm: () => void
}

const PermissionScopeConfirmationDialog = ({
  confirmation,
  onCancel,
  onConfirm
}: PermissionScopeConfirmationDialogProps): React.JSX.Element => {
  const { t } = useLanguage()
  const retainedConfirmation = useRetainedDialogValue(confirmation)
  const scope = retainedConfirmation?.scope ?? 'project'
  const subject = retainedConfirmation?.subject ?? t('permissionScope.thisPermission')
  const isProject = scope === 'project'
  // Composed through keys rather than concatenated fragments: word order differs per language.
  const scopePhrase = t(isProject ? 'permissionScope.scopeProject' : 'permissionScope.scopeGlobal')
  const coveragePhrase = t(
    isProject ? 'permissionScope.coverageProject' : 'permissionScope.coverageGlobal'
  )
  // Interpolated here rather than through t's vars: the confirmation suites render through the
  // non-interpolating fallback dictionary, and this sentence has to read complete there too.
  const effect = t(
    retainedConfirmation?.codeExecution
      ? 'permissionScope.effectCode'
      : 'permissionScope.effectActions'
  ).replace('{coverage}', coveragePhrase)

  return (
    <AlertDialog.Root
      open={Boolean(confirmation)}
      onOpenChange={(open) => {
        if (!open) onCancel()
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Overlay className={`${dialogOverlayClassName} z-[70]`} />
        <AlertDialog.Content
          className={dialogPanelClassName('z-[70] w-[min(420px,calc(100vw-2rem))]')}
          data-testid="permission-scope-confirmation"
        >
          <AlertDialog.Title className={`${dialogTitleClassName} min-w-0 [overflow-wrap:anywhere]`}>
            {t('permissionScope.title')
              .replace('{subject}', subject)
              .replace('{scope}', scopePhrase)}
          </AlertDialog.Title>
          <AlertDialog.Description className={dialogDescriptionClassName}>
            {effect} {t('permissionScope.revokeHint')}{' '}
            <strong className="font-semibold text-foreground">
              {t('permissionScope.settingsPath')}
            </strong>
            .
          </AlertDialog.Description>
          <div className={dialogFooterClassName}>
            <AlertDialog.Cancel asChild>
              <Button type="button" variant="outline" data-testid="permission-scope-cancel">
                {t('common.cancel')}
              </Button>
            </AlertDialog.Cancel>
            <AlertDialog.Action asChild>
              <Button
                type="button"
                variant="destructive"
                data-testid="permission-scope-confirm"
                onClick={onConfirm}
              >
                {t(isProject ? 'permissionScope.allowProject' : 'permissionScope.allowGlobal')}
              </Button>
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}

export {
  PermissionScopeConfirmationDialog,
  type BroadPermissionScope,
  type PermissionScopeConfirmation
}
