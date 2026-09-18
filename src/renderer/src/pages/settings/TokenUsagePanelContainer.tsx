import { useEffect, useState } from 'react'
import { useLanguage } from '@/i18n'

import type { Project } from '../../../../shared/projects'
import type { PersistedChatSession } from '../../../../shared/session-persistence'
import { TokenUsagePanel } from './TokenUsagePanel'

// The usage view is one of the few places that legitimately needs *every* session's content: per-run token
// attribution reads the conversation graph and each message's turnUsage, and the list tier deliberately does not
// carry those. So it fetches the full catalog when it is opened — the same data the app used to hold for every
// session at all times — instead of reading summaries, which would silently report zero usage rather than fail.
//
// It renders a loading state until the read lands: showing the panel with summaries would be the wrong-number
// bug this container exists to prevent, and showing an empty panel would look like "no usage".
type TokenUsagePanelContainerProps = {
  projects: readonly Project[]
}

export const TokenUsagePanelContainer = ({
  projects
}: TokenUsagePanelContainerProps): React.JSX.Element => {
  const { t } = useLanguage()
  const [sessions, setSessions] = useState<readonly PersistedChatSession[] | undefined>(undefined)

  useEffect(() => {
    let isActive = true
    void window.api.sessions
      .loadAll()
      .then((result) => {
        if (isActive) setSessions(result.sessions)
      })
      .catch(() => {
        // A failed read must not be shown as "no usage": leave it undefined and let the panel stay in its
        // loading state rather than claiming a total of zero.
        if (isActive) setSessions(undefined)
      })
    return () => {
      isActive = false
    }
  }, [])

  if (!sessions) return <p className="text-muted-foreground text-sm">{t('common.loading')}</p>

  return <TokenUsagePanel sessions={sessions} projects={projects} />
}
