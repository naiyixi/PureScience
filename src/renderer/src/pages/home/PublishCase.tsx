import { useState } from 'react'

import type { CasePublishOutcome } from '../../../../shared/case-publish'
import { useLanguage } from '@/i18n'

// Publishing sends the case to the shared shelf: the same bundle the export button writes, uploaded to this
// repository's `case-index` release, plus one entry in the index document.
//
// Two things this form deliberately does NOT do. It does not let the reader choose where the case goes — the
// repository, the release and the asset names are the app's decision, and a research tool has no business taking a
// URL to upload to. And it does not pre-fill the id with anything the reader cannot see: the id is what a later
// version of the same case replaces, so it is typed once and shown back.

type Translator = ReturnType<typeof useLanguage>['t']

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const describeProblem = (
  t: Translator,
  outcome: Extract<CasePublishOutcome, { status: 'refused' }>
): string => {
  switch (outcome.reason) {
    case 'no-credential':
      return t('home.userCases.publish.noCredential')
    case 'bad-id':
      return t('home.userCases.publish.badId')
    case 'missing-metadata':
      return t('home.userCases.publish.missingMetadata')
    case 'no-files':
      return t('home.userCases.publish.noFiles')
    case 'index-unreadable':
      return t('home.userCases.publish.indexUnreadable')
    case 'index-unreachable':
      return t('home.userCases.publish.indexUnreachable')
    case 'verify-failed':
      return t('home.userCases.publish.verifyFailed')
    case 'upload-failed':
    case 'index-upload-failed':
    case 'release-failed':
      return t('home.userCases.publish.uploadFailed')
    default:
      return t('home.userCases.publish.refused')
  }
}

type Status =
  | { kind: 'idle' }
  | { kind: 'working' }
  | { kind: 'published'; fileCount: number; totalBytes: number; sha256: string }
  | { kind: 'refused'; reason: string; detail?: string }

const fieldClassName =
  'w-full rounded-lg border border-border-200/70 bg-transparent px-2.5 py-1.5 text-sm text-text-000'
const labelClassName = 'block text-[11px] text-text-300'
const actionButtonClassName =
  'rounded-lg border border-border-200/70 px-3 py-1.5 text-sm text-text-000 transition-colors hover:border-text-300/60 disabled:opacity-50'

export const PublishCase = ({
  projectId,
  caseName,
  domain
}: {
  projectId: string
  caseName: string
  domain: string
}): React.JSX.Element => {
  const { t } = useLanguage()
  const [open, setOpen] = useState(false)
  const [id, setId] = useState('')
  const [name, setName] = useState(caseName)
  const [field, setField] = useState(domain)
  const [summary, setSummary] = useState('')
  const [author, setAuthor] = useState('')
  const [license, setLicense] = useState('')
  const [status, setStatus] = useState<Status>({ kind: 'idle' })

  const run = async (): Promise<void> => {
    setStatus({ kind: 'working' })
    let outcome: Awaited<ReturnType<typeof window.api.caseBundles.publish>>
    try {
      outcome = await window.api.caseBundles.publish({
        projectId,
        draft: {
          id: id.trim(),
          name: name.trim(),
          domain: field.trim(),
          summary: summary.trim(),
          author: author.trim(),
          license: license.trim()
        }
      })
    } catch (error) {
      // The channel itself missing reads as a refusal with the message kept, not as a page error.
      setStatus({ kind: 'refused', reason: error instanceof Error ? error.message : String(error) })
      return
    }
    if (outcome.status === 'published') {
      setStatus({
        kind: 'published',
        fileCount: outcome.fileCount,
        totalBytes: outcome.totalBytes,
        sha256: outcome.bundleSha256
      })
      return
    }
    setStatus({
      kind: 'refused',
      reason: describeProblem(t, outcome),
      ...(outcome.detail ? { detail: outcome.detail } : {})
    })
  }

  return (
    <div className="space-y-2" data-slot="case-publish">
      {open ? null : (
        <button
          type="button"
          className={actionButtonClassName}
          onClick={() => setOpen(true)}
          data-slot="case-publish-open"
        >
          {t('home.userCases.publish.open')}
        </button>
      )}

      {open ? (
        <div className="space-y-2" data-slot="case-publish-form">
          <div className="grid gap-2 md:grid-cols-2">
            <label className={labelClassName}>
              {t('home.userCases.publish.idLabel')}
              <input
                className={fieldClassName}
                value={id}
                onChange={(event) => setId(event.target.value)}
                placeholder="gpcr-activation"
                data-slot="case-publish-id"
              />
            </label>
            <label className={labelClassName}>
              {t('home.userCases.publish.nameLabel')}
              <input
                className={fieldClassName}
                value={name}
                onChange={(event) => setName(event.target.value)}
                data-slot="case-publish-name"
              />
            </label>
            <label className={labelClassName}>
              {t('home.userCases.publish.domainLabel')}
              <input
                className={fieldClassName}
                value={field}
                onChange={(event) => setField(event.target.value)}
                data-slot="case-publish-domain"
              />
            </label>
            <label className={labelClassName}>
              {t('home.userCases.publish.authorLabel')}
              <input
                className={fieldClassName}
                value={author}
                onChange={(event) => setAuthor(event.target.value)}
                data-slot="case-publish-author"
              />
            </label>
            <label className={labelClassName}>
              {t('home.userCases.publish.licenseLabel')}
              <input
                className={fieldClassName}
                value={license}
                onChange={(event) => setLicense(event.target.value)}
                placeholder="MIT"
                data-slot="case-publish-license"
              />
            </label>
            <label className={labelClassName}>
              {t('home.userCases.publish.summaryLabel')}
              <input
                className={fieldClassName}
                value={summary}
                onChange={(event) => setSummary(event.target.value)}
                data-slot="case-publish-summary"
              />
            </label>
          </div>
          <p className="text-[11px] text-text-300">{t('home.userCases.publish.identityHint')}</p>
          <div className="flex items-center gap-3">
            <button
              type="button"
              className={actionButtonClassName}
              disabled={status.kind === 'working'}
              onClick={() => void run()}
              data-slot="case-publish-submit"
            >
              {status.kind === 'working'
                ? t('home.userCases.publish.working')
                : t('home.userCases.publish.submit')}
            </button>
            <button
              type="button"
              className={actionButtonClassName}
              disabled={status.kind === 'working'}
              onClick={() => {
                setOpen(false)
                setStatus({ kind: 'idle' })
              }}
              data-slot="case-publish-cancel"
            >
              {t('home.userCases.publish.cancel')}
            </button>
          </div>
        </div>
      ) : null}

      {status.kind === 'published' ? (
        <p className="text-xs text-text-300" data-slot="case-publish-done">
          {t('home.userCases.publish.published')
            .replace('{count}', String(status.fileCount))
            .replace('{size}', formatBytes(status.totalBytes))
            .replace('{digest}', status.sha256.slice(0, 12))}
        </p>
      ) : null}
      {status.kind === 'refused' ? (
        <div className="space-y-1 text-xs text-destructive" data-slot="case-publish-error">
          <p>{status.reason}</p>
          {status.detail ? <p className="text-text-300">{status.detail}</p> : null}
        </div>
      ) : null}
    </div>
  )
}
