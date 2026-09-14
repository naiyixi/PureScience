import { describe, expect, it } from 'vitest'

import {
  buildTraceExportDocument,
  traceStepFromActivity,
  type TraceExportActivity
} from './trace-export'

const activity = (overrides: Partial<TraceExportActivity> = {}): TraceExportActivity => ({
  title: 'Run notebook cell',
  status: 'completed',
  sortIndex: 0,
  ...overrides
})

describe('traceStepFromActivity', () => {
  it('takes the step status from the activity, never from a guess', () => {
    expect(traceStepFromActivity(activity({ status: 'completed' })).status).toBe('done')
    expect(traceStepFromActivity(activity({ status: 'failed' })).status).toBe('failed')
  })

  it('reports an activity that never finished as unfinished, not as done', () => {
    const step = traceStepFromActivity(activity({ status: 'in_progress', title: 'Long run' }))

    expect(step.status).toBe('skipped')
    expect(step.detail).toContain('导出时该步骤仍未结束')
  })

  it('uses a recorded location as the evidence handle, with a line when one was recorded', () => {
    const step = traceStepFromActivity(
      activity({ toolLocations: [{ path: 'out/deg.csv', line: 12 }] })
    )

    expect(step.evidence).toBe('out/deg.csv:12')
  })

  it('falls back to the tool name, and claims no handle at all when there is none', () => {
    expect(traceStepFromActivity(activity({ providerToolName: 'notebook_run' })).evidence).toBe(
      'notebook_run'
    )
    // No location and no tool name: the step simply has no evidence handle — not an empty string that
    // would render as "checkable".
    expect(traceStepFromActivity(activity()).evidence).toBeUndefined()
  })

  it('carries a terminal exit code into the detail', () => {
    const step = traceStepFromActivity(
      activity({ status: 'failed', providerToolName: 'bash', terminalExitCode: 2 })
    )

    expect(step.detail).toBe('bash；退出码 2')
  })
})

describe('buildTraceExportDocument', () => {
  const base = {
    title: 'SHANK2 分析',
    generatedAt: '2026-09-14T12:00:00.000Z',
    project: 'proj-shank2'
  }

  it('keeps the recorded order of the activities', () => {
    const document = buildTraceExportDocument({
      ...base,
      activities: [
        activity({ title: 'third', sortIndex: 2 }),
        activity({ title: 'first', sortIndex: 0 }),
        activity({ title: 'second', sortIndex: 1 })
      ]
    })

    expect(document.steps.map((step) => step.label)).toEqual(['first', 'second', 'third'])
  })

  it('passes findings and human evidence through without merging them', () => {
    const document = buildTraceExportDocument({
      ...base,
      activities: [activity()],
      findings: [{ claim: '声称测试通过', status: 'fail' }],
      humanEvidence: [
        { snippet: 'I ran the suite', fingerprint: `sha256:${'a'.repeat(64)}`, role: 'user' }
      ]
    })

    expect(document.findings).toEqual([{ claim: '声称测试通过', status: 'fail' }])
    expect(document.humanEvidence?.[0].snippet).toBe('I ran the suite')
  })

  it('omits sections that have nothing in them', () => {
    const document = buildTraceExportDocument({ ...base, activities: [] })

    expect(document.steps).toEqual([])
    expect(document.findings).toBeUndefined()
    expect(document.humanEvidence).toBeUndefined()
    expect(document.scopes).toBeUndefined()
    expect(document.caveats).toBeUndefined()
  })

  it('carries the profile fields only when they are known', () => {
    const document = buildTraceExportDocument({
      title: 't',
      generatedAt: '2026-09-14T12:00:00.000Z',
      activities: []
    })

    expect(document.project).toBeUndefined()
    expect(document.goal).toBeUndefined()
  })
})
