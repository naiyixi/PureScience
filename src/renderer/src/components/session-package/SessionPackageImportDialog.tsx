import { FileUp } from 'lucide-react'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { useLanguage } from '@/i18n'
import type { SessionPackageImportPreview } from '../../../../shared/session-package-import'

type SessionPackageImportDialogProps = {
  open: boolean
  /**
   * The project an imported session lands in. Chosen by the caller — the package never picks its own
   * destination, and the session gets a new identity on arrival.
   */
  targetProjectId: string
  onClose: () => void
  onImported?: (sessionId: string) => void
}

// Two steps on purpose: a preview reads the package and shows what it holds (counts, the sender's own
// provenance claim, the reasons anything was left out), and only an explicit second action writes it.
// The read-only posture is stated before the user commits, not discovered afterwards.
const SessionPackageImportDialog = ({
  open,
  targetProjectId,
  onClose,
  onImported
}: SessionPackageImportDialogProps): React.JSX.Element | null => {
  const { t } = useLanguage()
  const [preview, setPreview] = useState<SessionPackageImportPreview | undefined>(undefined)
  const [busy, setBusy] = useState<'idle' | 'previewing' | 'importing'>('idle')
  const [refusal, setRefusal] = useState<string | undefined>(undefined)
  const [importedSessionId, setImportedSessionId] = useState<string | undefined>(undefined)

  if (!open) return null

  const handlePick = async (): Promise<void> => {
    setBusy('previewing')
    setRefusal(undefined)
    setImportedSessionId(undefined)
    setPreview(undefined)
    const result = await window.api.sessions.previewPackage({})
    setBusy('idle')
    // A closed picker is not a refused package, so nothing is reported as one.
    if (!result) return
    setPreview(result)
    if (!result.accepted) setRefusal(result.reason ?? 'not-a-package')
  }

  const handleImport = async (): Promise<void> => {
    const packagePath = preview?.packagePath
    if (!preview?.accepted || !packagePath) return
    setBusy('importing')
    setRefusal(undefined)
    const result = await window.api.sessions.importPackage({
      packagePath,
      confirm: { targetProjectId }
    })
    setBusy('idle')
    if (!result.ok) {
      setRefusal(result.reason)
      return
    }
    setImportedSessionId(result.sessionId)
    onImported?.(result.sessionId)
  }

  const described = preview?.accepted ? preview.described : undefined

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-lg rounded-lg border border-border bg-card p-4 shadow-lg">
        <h2 className="text-sm font-semibold">{t('sessions.packageImport.title')}</h2>
        <p className="mt-1.5 text-xs text-muted-foreground">
          {t('sessions.packageImport.readOnly')}
        </p>

        <div className="mt-3 flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={busy !== 'idle'}
            onClick={() => void handlePick()}
          >
            <FileUp className="size-4" aria-hidden="true" />
            {t('sessions.packageImport.pickFile')}
          </Button>
        </div>

        {described ? (
          <div className="mt-3 rounded-lg border border-border bg-muted/40 p-3">
            <p className="text-sm">{described.session.title}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {t('sessions.packageImport.contains')
                .replace('{messages}', String(described.counts.messages))
                .replace('{citations}', String(described.counts.citations))
                .replace('{findings}', String(described.counts.reviewFindings))
                .replace('{verifications}', String(described.counts.verificationRecords))
                .replace('{files}', String(described.counts.files))}
            </p>
            <p className="mt-2 text-xs">{t('sessions.packageImport.sourceParty')}</p>
            {described.notes.length > 0 ? (
              <ul className="mt-2 list-disc pl-4 text-xs text-muted-foreground">
                {described.notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}

        {refusal ? (
          <p className="mt-3 text-xs" role="alert">
            {t('sessions.packageImport.refused').replace('{reason}', refusal)}
          </p>
        ) : null}

        {importedSessionId ? (
          <p className="mt-3 text-xs text-muted-foreground" role="status">
            {importedSessionId}
          </p>
        ) : null}

        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('sessions.packageImport.cancel')}
          </Button>
          <Button
            type="button"
            disabled={busy !== 'idle' || !preview?.accepted || !preview.packagePath}
            onClick={() => void handleImport()}
          >
            {t('sessions.packageImport.confirm')}
          </Button>
        </div>
      </div>
    </div>
  )
}

export { SessionPackageImportDialog }
