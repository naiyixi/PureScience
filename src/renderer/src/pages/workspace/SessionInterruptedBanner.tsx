import { Loader2, Play } from 'lucide-react'

import { useLanguage } from '@/i18n'
import { Button } from '@/components/ui/button'
import { INTERRUPTED_SESSION_ERROR } from '../../../../shared/session-persistence'

type SessionInterruptedBannerProps = {
  message: string
  isDisabled: boolean
  isResuming: boolean
  onResume: () => void
}

const resumeButtonClassName =
  'gap-1.5 rounded-md text-[12px] text-text-000 hover:bg-bg-300 hover:text-text-000'

// Neutral recovery banner for a session interrupted by an app restart. The Resume button re-attaches
// the ACP runtime; while that request is in flight it is disabled so a second click cannot double-resume.
const SessionInterruptedBanner = ({
  message,
  isDisabled,
  isResuming,
  onResume
}: SessionInterruptedBannerProps): React.JSX.Element => {
  const { t } = useLanguage()
  // The canonical interrupted-session error is a shared English constant; show it localized so a
  // zh interface never surfaces an English paragraph.
  const displayMessage =
    message === INTERRUPTED_SESSION_ERROR ? t('ui.sessionInterrupted') : message
  return (
    <div className="mb-2 flex items-center gap-3 rounded-lg border border-border-200 bg-bg-200 px-3 py-2">
      <p className="min-w-0 flex-1 text-[12px] leading-5 text-text-100">{displayMessage}</p>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className={resumeButtonClassName}
        onClick={onResume}
        disabled={isDisabled || isResuming}
        aria-label={t('ui.resumesession')}
      >
        {isResuming ? (
          <Loader2 className="size-3.5 animate-spin" strokeWidth={2} aria-hidden="true" />
        ) : (
          <Play className="size-3.5" strokeWidth={2} aria-hidden="true" />
        )}
        {isResuming ? t('common.resuming') : t('common.resume')}
      </Button>
    </div>
  )
}

export { SessionInterruptedBanner }
