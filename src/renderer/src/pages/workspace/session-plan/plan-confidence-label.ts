import type { PlanConfidence } from '../../../../../shared/session-plan/contract'

const PLAN_CONFIDENCE_LABEL = {
  high: 'settings.planConfidenceHigh',
  medium: 'settings.planConfidenceMedium',
  low: 'settings.planConfidenceLow'
} as const satisfies Record<PlanConfidence, string>

const planConfidenceLabelKey = (confidence: PlanConfidence): string =>
  PLAN_CONFIDENCE_LABEL[confidence]

export { planConfidenceLabelKey }
