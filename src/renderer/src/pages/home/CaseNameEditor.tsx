import { useState } from 'react'

import { useLanguage } from '@/i18n'
import { useProjectStore } from '@/stores/project-store'

type Props = {
  projectId: string
  /** The name the case currently shows. Written into the project when the reader saves. */
  title: string
  summary: string | undefined
}

type Status =
  { kind: 'idle' } | { kind: 'saving' } | { kind: 'saved' } | { kind: 'failed'; detail: string }

/**
 * Names a case in the place the name belongs: the Project row.
 *
 * The home page used to get case titles from a table keyed by project id in this very file's module — a
 * table that only holds on the machine its ids were copied from. Saving here writes `caseTitle` /
 * `caseSummary` through the same `projects:update` channel the rest of the app uses, so the next reader
 * (another machine, another data root) sees the name without any build-time knowledge of this project.
 */
export const CaseNameEditor = ({ projectId, title, summary }: Props): React.JSX.Element => {
  const { t } = useLanguage()
  const updateProject = useProjectStore((state) => state.updateProject)
  const [draftTitle, setDraftTitle] = useState(title)
  const [draftSummary, setDraftSummary] = useState(summary ?? '')
  const [status, setStatus] = useState<Status>({ kind: 'idle' })

  const dirty = draftTitle.trim() !== title || draftSummary.trim() !== (summary ?? '')

  const save = async (): Promise<void> => {
    if (!dirty || status.kind === 'saving') return
    setStatus({ kind: 'saving' })
    try {
      const updated = await updateProject({
        id: projectId,
        caseTitle: draftTitle,
        caseSummary: draftSummary
      })
      if (!updated) {
        // `undefined` is how the store reports a refusal it already surfaced; do not claim it saved.
        setStatus({ kind: 'failed', detail: t('home.userCases.name.failed') })
        return
      }
      // What the row now holds is what the boxes show: the repository trims and caps, so echo that back
      // instead of leaving the reader's raw spacing in the form.
      setDraftTitle(updated.caseTitle ?? '')
      setDraftSummary(updated.caseSummary ?? '')
      setStatus({ kind: 'saved' })
    } catch (error) {
      setStatus({
        kind: 'failed',
        detail: error instanceof Error ? error.message : String(error)
      })
    }
  }

  return (
    <div className="mt-5 rounded-xl border border-border-200/70 p-3" data-slot="case-name-editor">
      <label
        className="block text-xs font-medium text-text-300"
        htmlFor={`case-title-${projectId}`}
      >
        {t('home.userCases.name.label')}
      </label>
      <div className="mt-1 flex items-center gap-2">
        <input
          id={`case-title-${projectId}`}
          value={draftTitle}
          onChange={(event) => setDraftTitle(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void save()
          }}
          maxLength={120}
          className="min-w-0 flex-1 rounded-lg border border-border-200/70 bg-transparent px-3 py-1.5 text-sm text-text-000"
          data-slot="case-name-title"
        />
        <button
          type="button"
          onClick={() => void save()}
          disabled={!dirty || status.kind === 'saving'}
          className="shrink-0 rounded-lg border border-border-200/70 px-3 py-1.5 text-sm text-text-000 transition-colors hover:border-text-300/60 disabled:opacity-40"
          data-slot="case-name-save"
        >
          {status.kind === 'saving' ? t('common.saving') : t('common.save')}
        </button>
      </div>
      <p className="mt-1 text-xs text-text-300">{t('home.userCases.name.hint')}</p>

      <label
        className="mt-3 block text-xs font-medium text-text-300"
        htmlFor={`case-summary-${projectId}`}
      >
        {t('home.userCases.summary.label')}
      </label>
      <input
        id={`case-summary-${projectId}`}
        value={draftSummary}
        onChange={(event) => setDraftSummary(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') void save()
        }}
        maxLength={400}
        placeholder={t('home.userCases.summary.hint')}
        className="mt-1 w-full rounded-lg border border-border-200/70 bg-transparent px-3 py-1.5 text-sm text-text-000"
        data-slot="case-name-summary"
      />

      {status.kind === 'saved' ? (
        <p className="mt-2 text-xs text-text-300" data-slot="case-name-saved">
          {t('home.userCases.name.saved')}
        </p>
      ) : null}
      {status.kind === 'failed' ? (
        <p className="mt-2 text-xs text-destructive" data-slot="case-name-failed">
          {t('home.userCases.name.failed', { reason: status.detail })}
        </p>
      ) : null}
    </div>
  )
}
