import { Info } from 'lucide-react'

import { useLanguage, type TranslationKey } from '@/i18n'
import { ScrollArea } from '@/components/ui/scroll-area'

import type { PlanDocumentV1 } from '../../../../../shared/session-plan/contract'
import { planConfidenceLabelKey } from './plan-confidence-label'
import type { PlanDocumentProjection } from './plan-file-projection'

// Notice strip shared by every Plan preview surface: stale, pending, continuation, and snapshot
// notices all render with the same chrome directly above the document body.
const PlanNoticeBanner = ({
  children
}: Readonly<{ children: React.ReactNode }>): React.JSX.Element => (
  <div className="border-b border-border bg-muted px-4 py-2 text-xs text-muted-foreground">
    {children}
  </div>
)

type PlanStepStatus = PlanDocumentProjection['stepStatuses'][string]['status'] | 'not_started' | 'not_run'

const STEP_STATUS_PRESENTATION: Record<
  PlanStepStatus,
  { mark: string; className: string }
> = {
  not_started: { mark: '', className: 'border-border text-muted-foreground' },
  not_run: { mark: '', className: 'border-border text-muted-foreground' },
  in_progress: { mark: '…', className: 'border-primary text-primary' },
  completed: { mark: '✓', className: 'border-emerald-500/60 text-emerald-600' },
  blocked: { mark: '!', className: 'border-destructive text-destructive' },
  skipped: { mark: '–', className: 'border-border text-muted-foreground' }
}

const stepStatusLabel = (status: PlanStepStatus): TranslationKey =>
  ({
    not_started: 'settings.planStepNotStarted',
    not_run: 'settings.planStepNotStarted',
    in_progress: 'settings.planStepInProgress',
    completed: 'settings.planStepCompleted',
    blocked: 'settings.planStepBlocked',
    skipped: 'settings.planStepSkipped'
  } as Record<PlanStepStatus, TranslationKey>)[status]

const validatedPreviewDocument = (value: unknown): PlanDocumentV1 | null => {
  if (!value || typeof value !== 'object') return null
  const doc = value as PlanDocumentV1
  if (doc.schema_version !== 1) return null
  return doc
}

const PlanDocumentBody = ({
  projection
}: Readonly<{ projection: PlanDocumentProjection }>): React.JSX.Element => {
  const { t } = useLanguage()

  const planDocument = validatedPreviewDocument(projection.document)
  if (!planDocument) return <></>
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="px-8 py-8">
        <h1 className="text-[22px] font-semibold">{planDocument.task_summary}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('settings.planPhasesInOrder').replace('{count}', String(planDocument.phases.length))}
        </p>
        {planDocument.phases.map((phase, phaseIndex) => (
          <section key={`${phaseIndex}:${phase.name}`} className="mt-7 border-t border-border pt-6">
            <div className="text-[10px] font-semibold tracking-[0.1em] text-muted-foreground">
              {t('settings.planPhaseLabel').replace('{number}', String(phaseIndex + 1))}
            </div>
            <h2 className="mt-1 text-lg font-medium">{phase.name}</h2>
            {phase.delegations.map((delegation, delegationIndex) => (
              <div
                key={`${delegationIndex}:${delegation.name}`}
                className="relative mt-4 border-l border-border pl-5"
              >
                <span
                  aria-hidden="true"
                  className="absolute left-[-4px] top-2 size-[7px] rounded-full bg-foreground"
                />
                <div className="flex items-baseline gap-2">
                  <span className="font-medium">{delegation.name}</span>
                  <span className="text-[11px] text-muted-foreground">
                    {phase.delegations.length === 1
                      ? t('settings.planPrimaryAgent')
                      : t('settings.planRunsInParallel')}
                  </span>
                </div>
                {delegation.steps.map((step) => {
                  const runtime = Object.hasOwn(projection.stepStatuses, step.title)
                    ? projection.stepStatuses[step.title]
                    : undefined
                  const projectedState = Object.hasOwn(projection.stepStates, step.title)
                    ? projection.stepStates[step.title]
                    : undefined
                  const state = projectedState ?? {
                    status: runtime?.status ?? ('not_started' as const),
                    ...(runtime?.notes ? { notes: runtime.notes } : {})
                  }
                  const presentation = STEP_STATUS_PRESENTATION[state.status]
                  return (
                    <div key={step.title} className="mt-3 grid grid-cols-[18px_1fr] gap-2">
                      <span
                        aria-label={t('settings.planStepStatusAria')
                          .replace('{step}', step.title)
                          .replace('{status}', t(stepStatusLabel(state.status)))}
                        className={`mt-0.5 grid size-4 place-items-center rounded border text-[10px] ${presentation.className}`}
                      >
                        {presentation.mark}
                      </span>
                      <div>
                        <div className="text-sm font-medium">{step.title}</div>
                        <div className="text-xs text-muted-foreground">{step.description}</div>
                        {state.notes && (state.status === 'blocked' || state.status === 'skipped') ? (
                          <div className="mt-1.5 rounded-md bg-muted px-2 py-1.5 text-[11px] text-muted-foreground">
                            {state.notes}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  )
                })}
              </div>
            ))}
          </section>
        ))}
        <section className="mt-7 border-t border-border pt-6">
          <h2 className="text-sm font-medium">{t('settings.planDesiredOutputs')}</h2>
          {planDocument.desired_outputs.length > 0 ? (
            <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-muted-foreground">
              {planDocument.desired_outputs.map((output) => (
                <li key={output}>{output}</li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-xs text-muted-foreground">
              {t('settings.planNoDesiredOutputs')}
            </p>
          )}
        </section>
        <div className="mt-7 rounded-lg bg-muted p-4">
          <div className="flex items-center gap-1.5 text-[10px] font-semibold tracking-[0.08em] text-muted-foreground">
            <Info className="size-3 shrink-0" aria-hidden="true" />
            {t('settings.planScopeFeasibility')} ·{' '}
            {t(planConfidenceLabelKey(planDocument.feasibility.confidence) as TranslationKey)}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{planDocument.feasibility.rationale}</p>
        </div>
      </div>
    </ScrollArea>
  )
}

export { PlanDocumentBody, PlanNoticeBanner }
