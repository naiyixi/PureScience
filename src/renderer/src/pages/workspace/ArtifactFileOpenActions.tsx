// Open/reveal cluster for a managed artifact or upload preview, shown beside Download. Both actions are
// resolved in the main process rather than handed a raw renderer path: `artifacts:open-file` walks the
// repository first (so the OS opener never sees an unmanaged location, and a path outside artifact storage
// is refused instead of opened), then reports the opener's own failure by name. A refusal is shown with
// those words, so a file that cannot be opened says why rather than looking like a button that does nothing.
import { CircleAlert, ExternalLink, FolderOpen } from 'lucide-react'
import { useState } from 'react'

import { useLanguage } from '@/i18n'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

export const ArtifactFileOpenActions = ({
  path,
  tooltipClassName
}: {
  path: string
  tooltipClassName?: string
}): React.JSX.Element => {
  const { t } = useLanguage()
  const [failure, setFailure] = useState<string | null>(null)

  const run = async (action: () => Promise<unknown>): Promise<void> => {
    setFailure(null)
    try {
      await action()
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error))
    }
  }

  const buttonClass = 'text-text-100 hover:text-text-000'

  return (
    <>
      {failure ? (
        <span
          data-testid="artifact-open-failure"
          role="status"
          className="inline-flex max-w-[22rem] shrink-0 items-center gap-1 rounded bg-warning-100 px-1.5 py-0.5 text-[10px] text-warning-900"
        >
          <CircleAlert className="size-3" aria-hidden="true" />
          <span className="truncate">
            {t('previewSurface.openFailed')}: {failure}
          </span>
        </span>
      ) : null}
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className={buttonClass}
              data-testid="artifact-open-with-system"
              aria-label={t('previewSurface.openWithSystemApp')}
              onClick={() => void run(() => window.api.artifacts.openFile({ path }))}
            >
              <ExternalLink aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent className={tooltipClassName}>
            {t('previewSurface.openWithSystemApp')}
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className={buttonClass}
              data-testid="artifact-show-in-folder"
              aria-label={t('previewSurface.showInFolder')}
              onClick={() => void run(() => window.api.artifacts.revealFile({ path }))}
            >
              <FolderOpen aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent className={tooltipClassName}>
            {t('previewSurface.showInFolder')}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </>
  )
}
