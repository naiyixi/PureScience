import { useState } from 'react'

import type {
  CaseBundleExportOutcome,
  CaseBundleImportOutcome
} from '../../../../shared/case-bundle'
import { useLanguage } from '@/i18n'

// Two ways a case leaves or enters this machine, both on the user-cases surface:
//
//   Export — picks a folder, then asks the main process to write the project's files there as a bundle. The
//   window never enumerates files itself: it names the project, and main resolves what that project has.
//   Import — picks a bundle folder, verifies every byte, and only then offers to copy it somewhere else.
//
// What the answer says matters as much as the action: an export that could not read one file says which one and
// writes nothing; an import that finds a checksum mismatch lists the names rather than saying "failed".

type Translator = ReturnType<typeof useLanguage>['t']

type Status =
  | { kind: 'idle' }
  | { kind: 'working' }
  | { kind: 'exported'; fileCount: number; totalBytes: number; directory: string }
  | {
      kind: 'imported'
      name: string
      fileCount: number
      totalBytes: number
      materialisedTo?: string
    }
  | {
      kind: 'refused'
      reason: string
      detail?: string
      missing?: string[]
      mismatch?: string[]
      unexpected?: string[]
    }

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const describeExportRefusal = (
  t: Translator,
  outcome: Extract<CaseBundleExportOutcome, { status: 'refused' }>
): string => {
  switch (outcome.reason) {
    case 'no-files':
      return t('home.userCases.bundle.exportNoFiles')
    case 'unreadable':
      return t('home.userCases.bundle.exportUnreadable')
    case 'bad-file-name':
    case 'duplicate-file-name':
      return t('home.userCases.bundle.exportBadName')
    case 'source-missing':
    case 'source-not-a-file':
      return t('home.userCases.bundle.exportSourceGone')
    default:
      return t('home.userCases.bundle.exportDestination')
  }
}

const describeImportRefusal = (
  t: Translator,
  outcome: Extract<CaseBundleImportOutcome, { status: 'refused' }>
): Status => {
  if (outcome.reason === 'incomplete') {
    return {
      kind: 'refused',
      reason: t('home.userCases.bundle.importIncomplete'),
      ...(outcome.problematic
        ? {
            missing: outcome.problematic.missing,
            mismatch: outcome.problematic.checksumMismatch,
            unexpected: outcome.problematic.unexpected
          }
        : {})
    }
  }
  const reason =
    outcome.reason === 'invalid-bundle'
      ? t('home.userCases.bundle.importForeign')
      : outcome.reason === 'manifest-missing' || outcome.reason === 'not-a-directory'
        ? t('home.userCases.bundle.importNotABundle')
        : t('home.userCases.bundle.importUnreadable')
  return { kind: 'refused', reason, ...(outcome.detail ? { detail: outcome.detail } : {}) }
}

const StatusLine = ({ status }: { status: Status }): React.JSX.Element | null => {
  const { t } = useLanguage()
  if (status.kind === 'idle') return null
  if (status.kind === 'working') {
    return <p className="text-xs text-text-300">{t('home.userCases.bundle.working')}</p>
  }
  if (status.kind === 'exported') {
    return (
      <p className="text-xs text-text-300">
        {t('home.userCases.bundle.exported')
          .replace('{count}', String(status.fileCount))
          .replace('{size}', formatBytes(status.totalBytes))
          .replace('{directory}', status.directory)}
      </p>
    )
  }
  if (status.kind === 'imported') {
    const template = status.materialisedTo
      ? t('home.userCases.bundle.imported')
      : t('home.userCases.bundle.verified')
    return (
      <p className="text-xs text-text-300">
        {template
          .replace('{name}', status.name)
          .replace('{count}', String(status.fileCount))
          .replace('{size}', formatBytes(status.totalBytes))
          .replace('{directory}', status.materialisedTo ?? '')}
      </p>
    )
  }
  return (
    <div className="space-y-1 text-xs text-destructive">
      <p>{status.reason}</p>
      {status.detail ? <p className="text-text-300">{status.detail}</p> : null}
      {status.missing?.length ? (
        <p className="text-text-300">
          {t('home.userCases.bundle.missingFiles').replace('{names}', status.missing.join(', '))}
        </p>
      ) : null}
      {status.mismatch?.length ? (
        <p className="text-text-300">
          {t('home.userCases.bundle.mismatchedFiles').replace(
            '{names}',
            status.mismatch.join(', ')
          )}
        </p>
      ) : null}
      {status.unexpected?.length ? (
        <p className="text-text-300">
          {t('home.userCases.bundle.unexpectedFiles').replace(
            '{names}',
            status.unexpected.join(', ')
          )}
        </p>
      ) : null}
    </div>
  )
}

const actionButtonClassName =
  'rounded-lg border border-border-200/70 px-3 py-1.5 text-sm text-text-000 transition-colors hover:border-text-300/60 disabled:opacity-50'

export const ExportCaseBundle = ({
  projectId,
  caseName,
  domain
}: {
  projectId: string
  caseName: string
  domain: string
}): React.JSX.Element => {
  const { t } = useLanguage()
  const [status, setStatus] = useState<Status>({ kind: 'idle' })

  const run = async (): Promise<void> => {
    setStatus({ kind: 'working' })
    const directory = await window.api.storage.pickDirectory()
    // A cancelled picker is not a failure, and saying nothing is the honest answer for it.
    if (!directory) {
      setStatus({ kind: 'idle' })
      return
    }
    const outcome = await window.api.caseBundles.exportBundle({
      projectId,
      caseName,
      domain,
      destinationDir: directory
    })
    if (outcome.status === 'exported') {
      setStatus({
        kind: 'exported',
        fileCount: outcome.fileCount,
        totalBytes: outcome.totalBytes,
        directory: outcome.bundleDir
      })
      return
    }
    setStatus({
      kind: 'refused',
      reason: describeExportRefusal(t, outcome),
      ...(outcome.detail ? { detail: outcome.detail } : {})
    })
  }

  return (
    <div className="space-y-1" data-slot="case-bundle-export">
      <button
        type="button"
        className={actionButtonClassName}
        disabled={status.kind === 'working'}
        onClick={() => void run()}
        data-slot="case-bundle-export-action"
      >
        {t('home.userCases.bundle.exportAction')}
      </button>
      <StatusLine status={status} />
    </div>
  )
}

export const ImportCaseBundle = (): React.JSX.Element => {
  const { t } = useLanguage()
  const [status, setStatus] = useState<Status>({ kind: 'idle' })

  const run = async (): Promise<void> => {
    setStatus({ kind: 'working' })
    const bundleDir = await window.api.storage.pickDirectory()
    if (!bundleDir) {
      setStatus({ kind: 'idle' })
      return
    }
    // First question: is this bundle whole? Only a whole bundle is offered a destination.
    const verified = await window.api.caseBundles.importBundle({ bundleDir })
    if (verified.status !== 'imported') {
      setStatus(describeImportRefusal(t, verified))
      return
    }
    const destination = await window.api.storage.pickDirectory()
    if (!destination) {
      setStatus({
        kind: 'imported',
        name: verified.name,
        fileCount: verified.fileCount,
        totalBytes: verified.totalBytes
      })
      return
    }
    const copied = await window.api.caseBundles.importBundle({
      bundleDir,
      materialiseTo: destination
    })
    if (copied.status === 'imported') {
      setStatus({
        kind: 'imported',
        name: copied.name,
        fileCount: copied.fileCount,
        totalBytes: copied.totalBytes,
        ...(copied.materialisedTo ? { materialisedTo: copied.materialisedTo } : {})
      })
      return
    }
    setStatus(describeImportRefusal(t, copied))
  }

  return (
    <div className="space-y-1" data-slot="case-bundle-import">
      <button
        type="button"
        className={actionButtonClassName}
        disabled={status.kind === 'working'}
        onClick={() => void run()}
        data-slot="case-bundle-import-action"
      >
        {t('home.userCases.bundle.importAction')}
      </button>
      <StatusLine status={status} />
    </div>
  )
}
