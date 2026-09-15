import type { SessionRetention } from '../../../../shared/session-retention'
import { useLanguage } from '@/i18n'
import { LOCALE_TAG } from '@/i18n/languages'

// A session document that had to drop its oldest messages says so here, above the transcript. The
// alternative — a conversation that silently begins mid-thread — reads as data loss the reader cannot
// account for, so the count and the moment it resumes from are both stated.
type TrimmedHistoryNoticeProps = {
  retention: SessionRetention | undefined
}

export function TrimmedHistoryNotice({
  retention
}: TrimmedHistoryNoticeProps): React.JSX.Element | null {
  const { lang, t } = useLanguage()
  if (!retention) return null

  return (
    <div
      data-testid="trimmed-history-notice"
      role="status"
      className="mx-auto mb-3 w-full max-w-[56rem] rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
    >
      {t('ws.historyTrimmed').replace('{count}', String(retention.droppedMessages))}
      {' · '}
      {t('ws.historyTrimmedResumes').replace(
        '{time}',
        new Date(retention.droppedBefore).toLocaleString(LOCALE_TAG[lang])
      )}
    </div>
  )
}
