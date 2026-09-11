// Execution-trace report (v1.54 unit 4): turns what a session actually did into a single auditable
// deliverable — steps with their status, the artifacts produced, the checkpoint facts that were
// reused, and the scope caveats that must travel with the numbers (subset previews, uncomputed
// quantities). The app already knows how to render a document to PDF through the Electron print
// surface; this module only builds the document, deterministically and injection-safe.

export type TraceReportStepStatus = 'done' | 'failed' | 'skipped'

export type TraceReportStep = {
  label: string
  status: TraceReportStepStatus
  detail?: string
  /** Where the step's result can be checked (file path, tool name, URL). */
  evidence?: string
}

export type TraceReportArtifact = {
  path: string
  kind?: string
  note?: string
}

export type TraceReportCheckpointRef = {
  facts?: { key: string; value: string; source: string }[]
  packages?: { name: string; version?: string }[]
  outputs?: { label: string; path?: string }[]
  freshness?: 'fresh' | 'stale' | 'missing'
}

export type TraceReportInput = {
  title: string
  project?: string
  generatedAt: string
  goal?: string
  /** Ordered steps; the report preserves the given order. */
  steps: TraceReportStep[]
  artifacts?: TraceReportArtifact[]
  checkpoint?: TraceReportCheckpointRef
  /** Scope labels that must accompany the numbers (e.g. '基于 2000/20000 降采样'). */
  scopes?: string[]
  /** Honest limitations: what was NOT computed, what needs a full run, what is unverified. */
  caveats?: string[]
}

const STATUS_LABEL: Record<TraceReportStepStatus, string> = {
  done: '完成',
  failed: '失败',
  skipped: '跳过'
}

export const escapeTraceHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

const orderedRows = <T>(items: readonly T[] | undefined, render: (item: T) => string): string[] =>
  (items ?? []).map(render)

export const buildTraceReportMarkdown = (input: TraceReportInput): string => {
  const lines: string[] = [`# ${input.title}`, '']
  const context: string[] = []
  if (input.project) context.push(`项目：${input.project}`)
  context.push(`生成时间：${input.generatedAt}`)
  if (input.goal) context.push(`目标：${input.goal}`)
  lines.push(...context, '')

  if (input.scopes && input.scopes.length > 0) {
    lines.push('## 结果范围', '')
    lines.push(...input.scopes.map((scope) => `- ${scope}`))
    lines.push('')
  }

  lines.push('## 执行步骤', '')
  if (input.steps.length === 0) {
    lines.push('- （无记录步骤）')
  } else {
    input.steps.forEach((step, index) => {
      const parts = [`${index + 1}. [${STATUS_LABEL[step.status]}] ${step.label}`]
      if (step.detail) parts.push(` — ${step.detail}`)
      if (step.evidence) parts.push(`（可核验：${step.evidence}）`)
      lines.push(parts.join(''))
    })
  }
  lines.push('')

  if (input.artifacts && input.artifacts.length > 0) {
    lines.push('## 产物', '')
    lines.push(
      ...orderedRows(
        input.artifacts,
        (artifact) =>
          `- ${artifact.path}${artifact.kind ? ` [${artifact.kind}]` : ''}${artifact.note ? ` — ${artifact.note}` : ''}`
      )
    )
    lines.push('')
  }

  const checkpoint = input.checkpoint
  if (checkpoint) {
    lines.push('## 检查点复用', '')
    if (checkpoint.freshness) lines.push(`- 新鲜度：${checkpoint.freshness}`)
    lines.push(
      ...orderedRows(
        checkpoint.facts,
        (fact) => `- 事实 ${fact.key} = ${fact.value}（来源：${fact.source}）`
      ),
      ...orderedRows(
        checkpoint.packages,
        (entry) => `- 依赖 ${entry.name}${entry.version ? `@${entry.version}` : ''}`
      ),
      ...orderedRows(
        checkpoint.outputs,
        (output) => `- 产物 ${output.label}${output.path ? ` → ${output.path}` : ''}`
      )
    )
    lines.push('')
  }

  if (input.caveats && input.caveats.length > 0) {
    lines.push('## 诚实性说明（必须随报告一并阅读）', '')
    lines.push(...input.caveats.map((caveat) => `- ${caveat}`))
    lines.push('')
  }

  return `${lines.join('\n').trimEnd()}\n`
}

export const buildTraceReportHtml = (input: TraceReportInput): string => {
  const markdown = buildTraceReportMarkdown(input)
  // Minimal, dependency-free rendering: the export pipeline styles the document; escaping keeps
  // session content (paths, tool output) from injecting markup.
  const body = markdown
    .split('\n')
    .map((line) => (line.trim() === '' ? '' : `<p>${escapeTraceHtml(line)}</p>`))
    .join('\n')
  return [
    '<!doctype html>',
    '<html lang="zh">',
    '<head><meta charset="utf-8" /><title>' + escapeTraceHtml(input.title) + '</title></head>',
    '<body class="trace-report">',
    body,
    '</body>',
    '</html>',
    ''
  ].join('\n')
}
