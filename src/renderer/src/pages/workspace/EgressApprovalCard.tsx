import { Globe, ShieldAlert } from 'lucide-react'
import { useEffect, useState } from 'react'

import { useLanguage } from '@/i18n'
import type { EgressApprovalDecision, EgressApprovalRequest } from '../../../../shared/egress'
import { Button } from '@/components/ui/button'

// In-conversation approval for a destination blocked by the notebook egress allowlist. The proxy
// suspends the offending request until the user decides; one-time decisions apply only to the
// exact request that triggered them, and "always allow" additionally persists the host into the
// egress customDomains so future requests bypass approval.
const EgressApprovalCard = ({
  request,
  expired = false,
  onRespond
}: {
  request: EgressApprovalRequest
  /** The proxy's deadline has passed: the request is already refused, so the card states that instead of
   *  offering controls that could not settle anything. */
  expired?: boolean
  onRespond: (requestId: string, decision: EgressApprovalDecision) => void
}): React.JSX.Element => {
  const { t } = useLanguage()
  const isDeny = request.method === 'CONNECT'
  // A live countdown from the deadline the main process reports. The card used to disappear at that deadline
  // without a word: a reader could not tell how long was left, or why it went away.
  const [secondsLeft, setSecondsLeft] = useState(Math.max(0, Math.round(request.expiresInSec)))
  useEffect(() => {
    if (expired) return
    const startedAt = Date.now()
    const timer = setInterval(() => {
      const remaining = Math.max(
        0,
        Math.round(request.expiresInSec - (Date.now() - startedAt) / 1000)
      )
      setSecondsLeft(remaining)
      if (remaining === 0) clearInterval(timer)
    }, 1000)
    return () => clearInterval(timer)
  }, [request.requestId, request.expiresInSec, expired])

  return (
    <div
      data-slot="egress-approval-card"
      data-expired={expired ? 'true' : 'false'}
      role="status"
      className="mx-2 mb-2 rounded-lg border border-border bg-card p-3 shadow-card"
    >
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-md bg-amber-500/10 text-amber-600 dark:text-amber-400">
          <Globe className="size-4" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground">{t('ws.egressApprovalTitle')}</p>
          <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
            {t('ws.egressApprovalDescription', {
              method: request.method,
              host: request.host
            })}
          </p>
          {request.path && request.path !== '/' ? (
            <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
              {request.path}
            </p>
          ) : null}
        </div>
      </div>
      {expired ? (
        <p
          className="mt-2 flex items-start gap-1.5 text-[11px] leading-4 text-muted-foreground"
          data-slot="egress-approval-expired"
        >
          <ShieldAlert className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
          {t('ws.egressApprovalExpired')}
        </p>
      ) : (
        <>
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onRespond(request.requestId, 'deny')}
            >
              {t('ws.egressDeny')}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onRespond(request.requestId, 'allow_once')}
            >
              {t('ws.egressAllowOnce')}
            </Button>
            <Button
              type="button"
              size="sm"
              className="ml-auto"
              onClick={() => onRespond(request.requestId, 'allow_always')}
            >
              {t('ws.egressAllowAlways')}
            </Button>
          </div>
          <p
            className="mt-2 text-[11px] leading-4 text-muted-foreground"
            data-slot="egress-approval-countdown"
          >
            {t('ws.egressApprovalExpiresIn', { seconds: String(secondsLeft) })}
          </p>
          {isDeny ? (
            <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-4 text-muted-foreground">
              <ShieldAlert className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
              {t('ws.egressConnectNote')}
            </p>
          ) : null}
        </>
      )}
    </div>
  )
}

export { EgressApprovalCard }
export type { EgressApprovalDecision, EgressApprovalRequest }
