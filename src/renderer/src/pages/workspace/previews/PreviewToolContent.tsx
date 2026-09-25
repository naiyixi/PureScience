import { useState } from 'react'

import { selectProjectSessionReviews, useReviewStore } from '@/stores/review-store'
import { useNavigationStore } from '@/stores/navigation-store'
import { type PreviewToolItem, usePreviewWorkbenchStore } from '@/stores/preview-workbench-store'
import { useSessionStore } from '@/stores/session-store'

import { NotebookPreview } from '../NotebookPreview'
import type { NotebookPreviewItem } from '../NotebookPreview'
import { ProjectFilesView } from '../ProjectFilesView'
import { SessionReviewerPanel } from '../SessionReviewerPanel'
import { VerificationChecklistPanel } from '../VerificationChecklistPanel'
import { FoldTimelinePanel } from '../FoldTimelinePanel'
import { respondToSessionPlan } from '../session-plan/respond-to-session-plan'
import { PlanPreviewSurface } from '../session-plan/SessionPlanSurfaces'

import { useLanguage } from '@/i18n'
import { cn } from '@/lib/utils'

const isNotebookPreviewItem = (item: PreviewToolItem): item is NotebookPreviewItem =>
  item.toolKind === 'notebook' && Boolean(item.notebook)

// Renders the Session reviewer surface for the tool item's session. Two tabs: "Checks" (the
// single-review panel, default — preserves the per-turn navigation target) and "Checklist" (the
// session-level verification checklist aggregating every warn/fail claim across all reviews).
const SessionReviewerContent = ({
  item,
  projectId
}: {
  item: PreviewToolItem
  projectId?: string
}): React.JSX.Element | null => {
  const { t } = useLanguage()
  const sessionId = item.reviewerSessionId ?? ''
  const [tab, setTab] = useState<'checks' | 'checklist' | 'context'>('checks')
  const reviews = useReviewStore((state) =>
    selectProjectSessionReviews(state.reviewsBySession, projectId, sessionId)
  )
  // Select the review the finding actually points at; fall back to the newest when the item carries
  // no reviewId (e.g. a session-level entry point) or that review is gone.
  const review = reviews.find((r) => r.id === item.reviewerReviewId) ?? reviews[0]

  const tabButton = (
    value: 'checks' | 'checklist' | 'context',
    label: string
  ): React.JSX.Element => (
    <button
      type="button"
      className={cn(
        'rounded px-2 py-1 text-[11px] font-medium transition-colors',
        tab === value ? 'bg-bg-200 text-text-000' : 'text-text-400 hover:text-text-300'
      )}
      onClick={() => setTab(value)}
      data-testid={`reviewer-tab-${value}`}
      aria-pressed={tab === value}
    >
      {label}
    </button>
  )

  // The checklist and the folded-context timeline are session-scoped and independent of a specific
  // review; only the checks tab needs a review row. A session with no reviews yet still reaches both,
  // and says why the checks tab is missing rather than showing a surface that looks broken.
  if (!review) {
    return (
      <div className="flex size-full flex-col overflow-hidden">
        <div className="shrink-0 border-b border-border-200 px-4 py-2">
          <div
            className="flex items-center gap-1"
            role="tablist"
            aria-label={t('reviewer.viewsTablist')}
          >
            {tabButton('checklist', t('ui.checklist'))}
            {tabButton('context', t('ui.foldedcontext'))}
          </div>
        </div>
        <p
          data-testid="reviewer-no-review"
          className="shrink-0 border-b border-border-200 px-4 py-2 text-[11px] text-text-300"
        >
          {t('reviewer.noReviewsYet')}
        </p>
        <div className="flex-1 overflow-hidden">
          {tab === 'context' ? (
            <FoldTimelinePanel projectId={projectId ?? ''} sessionId={sessionId} />
          ) : (
            <VerificationChecklistPanel
              projectId={projectId ?? ''}
              sessionId={sessionId}
              onGoToTranscript={() => {
                setTab('checks')
              }}
            />
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="flex size-full flex-col overflow-hidden">
      <div className="shrink-0 border-b border-border-200 px-4 py-2">
        <div
          className="flex items-center gap-1"
          role="tablist"
          aria-label={t('reviewer.viewsTablist')}
        >
          {tabButton('checks', t('ui.checks'))}
          {tabButton('checklist', t('ui.checklist'))}
          {tabButton('context', t('ui.foldedcontext'))}
        </div>
      </div>
      <div className="flex-1 overflow-hidden">
        {tab === 'checks' ? (
          <SessionReviewerPanel review={review} activeFindingId={item.reviewerActiveFindingId} />
        ) : tab === 'checklist' ? (
          <VerificationChecklistPanel
            projectId={projectId ?? ''}
            sessionId={sessionId}
            onGoToTranscript={() => {
              // Jumping to a claim's transcript lands on the checks tab of the review that owns it.
              // The panel re-selects the matching review via reviewerReviewId when present.
              setTab('checks')
            }}
          />
        ) : (
          <FoldTimelinePanel projectId={projectId ?? ''} sessionId={sessionId} />
        )}
      </div>
    </div>
  )
}

export const PreviewToolContent = ({
  item
}: {
  item: PreviewToolItem
}): React.JSX.Element | null => {
  const activeProjectId = useNavigationStore((state) => state.activeProjectId)
  // Read the Session's *fields*, not the Session object: a streamed chunk replaces it several times a
  // second (see transcript-render-identity), and taking the object made this surface re-render — plan
  // projection and all — for text that belongs to the transcript. Each selection below is an
  // `Object.is`-comparable value that only moves when the preview actually has something new to show.
  const planActiveProjection = useSessionStore(
    (state) => state.sessions.find((session) => session.id === item.sessionId)?.activePlanProjection
  )
  const planHistoryProjections = useSessionStore(
    (state) =>
      state.sessions.find((session) => session.id === item.sessionId)?.planHistoryProjections
  )
  const planSessionExists = useSessionStore((state) =>
    state.sessions.some((session) => session.id === item.sessionId)
  )
  const canRespondToPlan = useSessionStore((state) => {
    const session = state.sessions.find((candidate) => candidate.id === item.sessionId)
    return session?.status === 'waiting-plan-approval' && session.activeRun !== undefined
  })
  const isPlanExpanded = usePreviewWorkbenchStore((state) => state.expandedToolItemId === item.id)
  const setToolItemExpanded = usePreviewWorkbenchStore((state) => state.setToolItemExpanded)
  const activePlanProjection = planActiveProjection
  const planProjection = item.planArtifactVersionId
    ? (planHistoryProjections?.find(
        (projection) => projection.artifactVersionId === item.planArtifactVersionId
      ) ??
      (activePlanProjection?.artifactVersionId === item.planArtifactVersionId
        ? activePlanProjection
        : undefined))
    : activePlanProjection

  const respondPlan = async (decision: 'approved' | 'rejected'): Promise<void> => {
    if (!planProjection || !item.projectId) return
    await respondToSessionPlan(
      { projectId: item.projectId, sessionId: item.sessionId, projection: planProjection },
      { decision }
    )
  }

  // Remount the Files tool per project so its transient dialog cannot outlive the project it opened.
  if (item.toolKind === 'files') {
    return <ProjectFilesView key={activeProjectId ?? 'no-active-project'} />
  }

  if (item.toolKind === 'reviewer') {
    return <SessionReviewerContent item={item} projectId={activeProjectId} />
  }

  if (item.toolKind === 'plan') {
    if (!planProjection || !planSessionExists) return null
    const stale = planProjection.artifactVersionId !== activePlanProjection?.artifactVersionId
    return (
      <PlanPreviewSurface
        projection={planProjection}
        stale={stale}
        isFullScreen={isPlanExpanded}
        onRespond={canRespondToPlan ? respondPlan : undefined}
        onToggleFullScreen={() => setToolItemExpanded(isPlanExpanded ? null : item.id)}
      />
    )
  }

  if (!isNotebookPreviewItem(item)) return null

  return <NotebookPreview item={item} />
}
