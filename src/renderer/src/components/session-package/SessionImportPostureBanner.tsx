import { Lock } from 'lucide-react'

import { useLanguage } from '@/i18n'
import type { SessionPackageImportRecord } from '../../../../shared/session-package-import'

type SessionImportPostureBannerProps = {
  record: SessionPackageImportRecord
}

// The posture an imported session carries, shown on the session itself rather than only in the import
// dialog that once mentioned it: reopening it must say where it came from, when it left the other
// machine, and that nothing on this machine has verified it. Read-only is a property of the arrival, so
// it is stated as one — not left to be discovered later as a refusal.
const SessionImportPostureBanner = ({
  record
}: SessionImportPostureBannerProps): React.JSX.Element => {
  const { t } = useLanguage()
  return (
    <div
      role="status"
      data-testid="session-import-posture"
      className="flex flex-col gap-1 border-b border-border bg-muted/40 px-4 py-3 text-xs leading-5 text-muted-foreground"
    >
      <p className="flex items-center gap-2 font-medium text-foreground">
        <Lock aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
        <span data-testid="session-import-posture-readonly">
          {t('sessions.importPosture.title')}
        </span>
      </p>
      <p data-testid="session-import-posture-origin">
        {t('sessions.importPosture.importedFrom', {
          project: record.importedFrom.projectId,
          session: record.importedFrom.sessionId,
          appVersion: record.importedFrom.appVersion
        })}
      </p>
      <p data-testid="session-import-posture-exported">
        {t('sessions.importPosture.exportedAt', { when: record.importedFrom.exportedAt })}
      </p>
      <p data-testid="session-import-posture-unverified">
        {t('sessions.importPosture.notVerified')} {t('sessions.packageImport.readOnly')}
      </p>
    </div>
  )
}

export { SessionImportPostureBanner }
