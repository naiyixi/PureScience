import { Loader2, Play, PlayCircle } from 'lucide-react'

import { useLanguage } from '@/i18n'
import { Button } from '@/components/ui/button'
import { INTERRUPTED_SESSION_ERROR } from '../../../../shared/session-persistence'

type SessionInterruptedBannerProps = {
  message: string
  isDisabled: boolean
  isResuming: boolean
  isContinuing: boolean
  /** Whether there is an unfinished turn to hand back (it needs a message to continue). */
  canContinue: boolean
  continueError?: string
  onResume: () => void
  onContinue: () => void
}

const actionButtonClassName =
  'gap-1.5 rounded-md text-[12px] text-text-000 hover:bg-bg-300 hover:text-text-000'

// Neutral recovery banner for a session interrupted by an app restart.
//
// Two actions, and they are not the same action:
//   Continue — hands the recorded turn back to the agent so it carries on from where it stopped. The
//              message and its attachments stay the ones that were sent, and a continuation already in
//              flight for that session is left alone instead of being started twice.
//   Resume   — re-attaches the runtime and sends the message again as a fresh turn.
// The difference is written in the banner, because the two buttons look alike and mean different things.
// While a request is in flight both are disabled, so a second click cannot double-start either one.
const SessionInterruptedBanner = ({
  message,
  isDisabled,
  isResuming,
  isContinuing,
  canContinue,
  continueError,
  onResume,
  onContinue
}: SessionInterruptedBannerProps): React.JSX.Element => {
  const { t } = useLanguage()
  // The canonical interrupted-session error is a shared English constant; show it localized so a
  // zh interface never surfaces an English paragraph.
  const displayMessage =
    message === INTERRUPTED_SESSION_ERROR ? t('ui.sessionInterrupted') : message

  return (
    <div className="mb-2 rounded-lg border border-border-200 bg-bg-200 px-3 py-2">
      <div className="flex items-center gap-3">
        <p className="min-w-0 flex-1 text-[12px] leading-5 text-text-100">{displayMessage}</p>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={actionButtonClassName}
          onClick={onContinue}
          disabled={isDisabled || isContinuing || isResuming || !canContinue}
          aria-label={canContinue ? t('ws.continueTurn') : t('ws.continueTurnUnavailable')}
          title={canContinue ? t('ws.continueTurnHint') : t('ws.continueTurnUnavailable')}
          data-testid="session-interrupted-continue"
        >
          {isContinuing ? (
            <Loader2 className="size-3.5 animate-spin" strokeWidth={2} aria-hidden="true" />
          ) : (
            <PlayCircle className="size-3.5" strokeWidth={2} aria-hidden="true" />
          )}
          {isContinuing ? t('ws.continuing') : t('ws.continueTurn')}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={actionButtonClassName}
          onClick={onResume}
          disabled={isDisabled || isResuming || isContinuing}
          aria-label={t('ui.resumesession')}
          title={t('ws.resumeTurnHint')}
          data-testid="session-interrupted-resume"
        >
          {isResuming ? (
            <Loader2 className="size-3.5 animate-spin" strokeWidth={2} aria-hidden="true" />
          ) : (
            <Play className="size-3.5" strokeWidth={2} aria-hidden="true" />
          )}
          {isResuming ? t('common.resuming') : t('common.resume')}
        </Button>
      </div>
      {/* The two actions differ, so the banner says how: the hints are the visible difference. */}
      <p
        className="mt-1 text-[11px] leading-4 text-text-200"
        data-testid="session-interrupted-hints"
      >
        {t('ws.continueTurnHint')} · {t('ws.resumeTurnHint')}
      </p>
      {continueError ? (
        <p
          role="alert"
          className="mt-1 text-[11px] leading-4 text-red-700 dark:text-red-300"
          data-testid="session-interrupted-error"
        >
          {continueError}
        </p>
      ) : null}
    </div>
  )
}

export { SessionInterruptedBanner }
