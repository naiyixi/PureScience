import { useEffect, useRef, useState } from 'react'
import { Dialog } from 'radix-ui'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
import { useLanguage } from '@/i18n'
import { useDialogFocusRestore } from '@/components/ui/dialog-focus-restore'
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
  // One request per opening. The effect used to depend on `entries.length` and `loading`, so an EMPTY
  // result could never satisfy its own guard: setEntries([]) + setLoading(false) re-triggered the
  // effect and asked again — a loop that hammered the main process (real log: 371 collection runs in
  // 0.228 s from a single open dialog, `main*.log` 2026-09-18, each one logging a failed read). The
  // ref keeps the request count independent of the answer, and is cleared on failure so reopening the
  // dialog retries instead of showing the error forever.
  const requestedRef = useRef(false)

  useEffect(() => {
    if (!open || requestedRef.current) return
    requestedRef.current = true
    void (async () => {
      setLoading(true)
      try {
        const result = await window.api.settings.getThirdPartyLicenses()
        setEntries(result)
        setError(null)
      } catch {
        requestedRef.current = false
        setError(t('settings.thirdPartyLicensesFailed'))
      } finally {
        setLoading(false)
      }
    })()
  }, [open, t])

  // Closing this dialog used to drop focus on <body>: there is no Dialog.Trigger, and the page
  // unmounts the layer instead of closing it. The hook captures the opener on open and hands focus
  // back on the way out — including the unmount path.
  const focusRestore = useDialogFocusRestore(open)

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={dialogOverlayClassName} />
        <Dialog.Content
          onOpenAutoFocus={focusRestore.onOpenAutoFocus}
          onCloseAutoFocus={focusRestore.onCloseAutoFocus}
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
