import { useEffect, useState } from 'react'

import type { BackgroundDelivery } from '../../../shared/background-delivery'
import { formatBackgroundDeliveryLine } from '../../../shared/background-delivery'
import { backgroundDeliveryLabelsFor } from '../../../shared/background-delivery-labels'
import { useLanguage } from '@/i18n'
import { LOCALE_TAG } from '@/i18n/languages'

// Where a delivered background result came from, shown on the job it belongs to. The main process
// decides when a result is delivered; this panel is the receipt: which state the delivery reached,
// the fingerprint anyone can recompute, which trigger produced it, and the files it carried. Wording
// comes from the shared label set, so the panel and the continuation turn written into the session say
// the same thing in the same language.
type JobDeliveryLedgerProps = {
  sessionId: string
  jobId: string
}

function Row({
  label,
  value,
  mono
}: {
  label: string
  value: string
  mono?: boolean
}): React.JSX.Element {
  return (
    <>
      <dt className="truncate">{label}</dt>
      <dd className={mono ? 'break-all font-mono text-foreground' : 'break-all text-foreground'}>
        {value}
      </dd>
    </>
  )
}

export function JobDeliveryLedger({
  sessionId,
  jobId
}: JobDeliveryLedgerProps): React.JSX.Element | null {
  const { lang, t } = useLanguage()
  const [delivery, setDelivery] = useState<BackgroundDelivery | undefined>(undefined)
  // Which delivery was copied, rather than a bare flag: a delivery that changes must not inherit the
  // "copied" state of the one before it.
  const [copiedId, setCopiedId] = useState<string | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    // A shell without the ledger surface (an older window, a test harness) has no ledger to show: the
    // panel stays out rather than throwing on a method that is not there.
    const listDeliveries = window.api?.compute?.deliveriesList
    if (!listDeliveries) return
    void listDeliveries
      .call(window.api.compute, sessionId)
      .then((deliveries) => {
        if (!cancelled) setDelivery(deliveries.find((entry) => entry.jobId === jobId))
      })
      .catch(() => {
        // A ledger that cannot be read is not an error the job view should shout about; it shows nothing.
        if (!cancelled) setDelivery(undefined)
      })
    return () => {
      cancelled = true
    }
  }, [sessionId, jobId])

  // No delivery record means the main process has not written this result into the session (yet, or at
  // all): the panel stays out of the way instead of claiming a delivery that did not happen.
  if (!delivery) return null

  const labels = backgroundDeliveryLabelsFor(lang)
  const stateText = labels.stateNames[delivery.state]
  const reasonText = delivery.reason ? labels.reasonNames[delivery.reason] : undefined
  const updatedAt = new Date(delivery.updatedAt).toLocaleString(LOCALE_TAG[lang])

  const copyDetails = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(formatBackgroundDeliveryLine(delivery, labels))
      setCopiedId(delivery.id)
    } catch {
      // Clipboard access can be refused; the identical details are already on screen.
      setCopiedId(undefined)
    }
  }

  return (
    <section
      data-testid="job-delivery-ledger"
      aria-label={labels.header}
      className="shrink-0 border-b border-border bg-muted/20 px-4 py-2.5 text-[12px]"
    >
      <div className="flex items-center gap-2">
        <span className="font-medium">{labels.header}</span>
        <span data-testid="job-delivery-state" className="text-muted-foreground">
          {stateText}
        </span>
        {reasonText ? (
          <span data-testid="job-delivery-reason" className="text-destructive">
            {reasonText}
          </span>
        ) : null}
        <button
          type="button"
          data-testid="job-delivery-copy"
          className="ml-auto shrink-0 rounded border border-border px-2 py-0.5 text-[11px] hover:bg-muted"
          onClick={() => void copyDetails()}
        >
          {copiedId === delivery.id ? t('jobDetail.deliveryCopied') : t('jobDetail.deliveryCopy')}
        </button>
      </div>
      <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-muted-foreground">
        <Row label={labels.job} value={delivery.jobId} mono />
        <Row label={t('jobDetail.deliveryTrigger')} value={delivery.sourceKind} />
        <Row label={labels.fingerprint} value={delivery.fingerprint ?? '—'} mono />
        <Row
          label={labels.files}
          value={delivery.outputFiles.length > 0 ? delivery.outputFiles.join(', ') : '—'}
        />
        <Row label={t('jobDetail.deliveryUpdated')} value={updatedAt} />
      </dl>
    </section>
  )
}
