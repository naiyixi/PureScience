// Assembles the execution-trace document from what the app already holds, so the export is built from
// recorded facts rather than from a prompt-time narrative.
//
// Two rules, both about not inventing anything:
//   * a step's status comes only from the activity's own status, and an activity that never finished is
//     reported as unfinished rather than dressed up as done or silently dropped;
//   * a step's evidence handle is only set when the activity actually recorded a location or a tool
//     name — an empty handle would read as "checkable" when there is nothing to check.

import type { ConversationExportTrace } from './conversation-export'
import type { TraceReportFinding, TraceReportHumanEvidence, TraceReportStep } from './trace-report'

export type TraceExportActivityStatus = 'pending' | 'in_progress' | 'completed' | 'failed'

export type TraceExportActivity = {
  title: string
  status: TraceExportActivityStatus
  sortIndex: number
  providerToolName?: string
  toolLocations?: readonly { path: string; line?: number | null }[]
  terminalExitCode?: number | null
}

const statusOf = (status: TraceExportActivityStatus): TraceReportStep['status'] => {
  if (status === 'completed') return 'done'
  if (status === 'failed') return 'failed'

  return 'skipped'
}

const detailOf = (activity: TraceExportActivity): string | undefined => {
  const parts: string[] = []
  if (activity.providerToolName) parts.push(activity.providerToolName)
  if (activity.status === 'pending' || activity.status === 'in_progress') {
    parts.push('导出时该步骤仍未结束')
  }
  if (typeof activity.terminalExitCode === 'number')
    parts.push(`退出码 ${activity.terminalExitCode}`)

  return parts.length > 0 ? parts.join('；') : undefined
}

const evidenceOf = (activity: TraceExportActivity): string | undefined => {
  const location = activity.toolLocations?.[0]
  if (location) {
    return location.line ? `${location.path}:${location.line}` : location.path
  }

  return activity.providerToolName
}

export const traceStepFromActivity = (activity: TraceExportActivity): TraceReportStep => ({
  label: activity.title,
  status: statusOf(activity.status),
  ...(detailOf(activity) ? { detail: detailOf(activity) } : {}),
  ...(evidenceOf(activity) ? { evidence: evidenceOf(activity) } : {})
})

export type TraceExportInput = {
  title: string
  generatedAt: string
  project?: string
  goal?: string
  activities: readonly TraceExportActivity[]
  /** What the reviewer model claimed — passed through, never merged with the pins below. */
  findings?: readonly TraceReportFinding[]
  /** What a person pinned — passed through, never merged with the findings above. */
  humanEvidence?: readonly TraceReportHumanEvidence[]
  scopes?: readonly string[]
  caveats?: readonly string[]
}

export const buildTraceExportDocument = (input: TraceExportInput): ConversationExportTrace => {
  // Recorded order is the transcript's order; sorting here would rewrite the history the report claims
  // to reproduce.
  const steps = [...input.activities]
    .sort((left, right) => left.sortIndex - right.sortIndex)
    .map(traceStepFromActivity)

  return {
    title: input.title,
    generatedAt: input.generatedAt,
    ...(input.project ? { project: input.project } : {}),
    ...(input.goal ? { goal: input.goal } : {}),
    steps,
    ...(input.findings && input.findings.length > 0 ? { findings: [...input.findings] } : {}),
    ...(input.humanEvidence && input.humanEvidence.length > 0
      ? { humanEvidence: [...input.humanEvidence] }
      : {}),
    ...(input.scopes && input.scopes.length > 0 ? { scopes: [...input.scopes] } : {}),
    ...(input.caveats && input.caveats.length > 0 ? { caveats: [...input.caveats] } : {})
  }
}
