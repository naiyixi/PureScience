import { useLanguage, type Translate } from '@/i18n'
import { Button } from '@/components/ui/button'
import { useState } from 'react'

import type { HandoffTranscriptProjection } from './handoff-lifecycle-projection'

const targetLabel = (target: HandoffTranscriptProjection['target'], t: Translate): string =>
  target.kind === 'main' ? t('ws.mainAgent') : target.name

const statusCopy = (handoff: HandoffTranscriptProjection, t: Translate): string => {
  const target = targetLabel(handoff.target, t)

  switch (handoff.phase) {
    case 'awaiting-approval':
      return t('handoff.awaitingApproval', { target })
    case 'switching':
      return t('handoff.switching', { target })
    case 'reconfiguring':
      return t('handoff.reconfiguring', { target })
    case 'continuation-start':
      return t('handoff.continuationStart', { target })
    case 'continued':
      return t('handoff.continued', { target })
    case 'failed':
      return t('handoff.failedContinue', { target })
  }
}

const HandoffLifecycleStatus = ({
  handoff,
  onRetry
}: {
  handoff: HandoffTranscriptProjection
  onRetry?: () => Promise<void>
}): React.JSX.Element => {
  const { t } = useLanguage()
  const isFailure = handoff.phase === 'failed'
  const [isRetrying, setIsRetrying] = useState(false)
  const [retryError, setRetryError] = useState<string | undefined>()

  const retry = async (): Promise<void> => {
    if (!onRetry || isRetrying) return
    setIsRetrying(true)
    setRetryError(undefined)
    try {
      await onRetry()
    } catch {
      setRetryError('Retry could not start. The saved handoff remains available.')
    } finally {
      setIsRetrying(false)
    }
  }

  return (
    <div
      data-handoff-lifecycle=""
      data-originating-turn-id={handoff.originatingTurnId}
      data-originating-user-message-id={handoff.originatingUserMessageId}
      data-handoff-phase={handoff.phase}
      role={isFailure ? 'alert' : 'status'}
      aria-live={isFailure ? 'assertive' : 'polite'}
      className={
        isFailure
          ? 'rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive'
          : 'rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground'
      }
    >
      <span className="font-medium text-foreground">{statusCopy(handoff, t)}</span>
      {handoff.phase === 'continued' ? (
        <span className="ml-1">{t('ui.theoriginaltaskcontinuesinth')}</span>
      ) : null}
      {handoff.failure ? <span className="ml-1">{handoff.failure.message}</span> : null}
      {isFailure && onRetry ? (
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="ml-2"
          disabled={isRetrying}
          onClick={() => void retry()}
        >
          {isRetrying ? t('common.retrying') : t('common.retryHandoff')}
        </Button>
      ) : null}
      {isFailure && retryError ? <span className="ml-1">{retryError}</span> : null}
    </div>
  )
}

export { HandoffLifecycleStatus }
