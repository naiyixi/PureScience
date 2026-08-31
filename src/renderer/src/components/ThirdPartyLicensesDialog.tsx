import { useEffect, useState } from 'react'
import { Dialog } from 'radix-ui'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
import { useLanguage } from '@/i18n'
import {
  dialogDescriptionClassName,
  dialogFooterClassName,
  dialogHeaderClassName,
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogTitleClassName
} from '@/components/ui/dialog-chrome'

type ThirdPartyLicenseEntry = {
  name: string
  version: string
  license: string
}

type ThirdPartyLicensesDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
}

// Settings → General → About → Third-Party Licenses: lists the license summaries collected from the
// installed dependency tree so users can review what ships inside the app.
const ThirdPartyLicensesDialog = ({
  open,
  onOpenChange
}: ThirdPartyLicensesDialogProps): React.JSX.Element => {
  const { t } = useLanguage()
  const [entries, setEntries] = useState<ThirdPartyLicenseEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open || entries.length > 0 || loading) return
    void (async () => {
      setLoading(true)
      try {
        const result = await window.api.settings.getThirdPartyLicenses()
        setEntries(result)
        setError(null)
      } catch {
        setError(t('settings.thirdPartyLicensesFailed'))
      } finally {
        setLoading(false)
      }
    })()
  }, [open, entries.length, loading, t])

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={dialogOverlayClassName} />
        <Dialog.Content
          className={dialogPanelClassName(
            'flex max-h-[min(640px,calc(100vh-2rem))] w-[min(560px,calc(100vw-2rem))] flex-col'
          )}
        >
          <div className={dialogHeaderClassName}>
            <Dialog.Title className={dialogTitleClassName}>
              {t('settings.thirdPartyLicenses')}
            </Dialog.Title>
            <Dialog.Description className={dialogDescriptionClassName}>
              {t('settings.thirdPartyLicensesDesc')}
            </Dialog.Description>
          </div>

          <ScrollArea className="min-h-0 flex-1 px-5">
            {loading ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                {t('settings.thirdPartyLicensesLoading')}
              </p>
            ) : error ? (
              <p className="py-8 text-center text-sm text-destructive">{error}</p>
            ) : entries.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                {t('settings.thirdPartyLicensesEmpty')}
              </p>
            ) : (
              <ul className="flex flex-col gap-4 py-4">
                {entries.map((entry) => (
                  <li key={entry.name} className="flex flex-col gap-1">
                    <span className="text-sm font-semibold text-foreground">
                      {entry.name}{' '}
                      <span className="font-normal text-muted-foreground">v{entry.version}</span>
                    </span>
                    <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-2 text-[11px] leading-4 text-muted-foreground">
                      {entry.license}
                    </pre>
                  </li>
                ))}
              </ul>
            )}
          </ScrollArea>

          <div className={dialogFooterClassName}>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t('common.close')}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export { ThirdPartyLicensesDialog }
