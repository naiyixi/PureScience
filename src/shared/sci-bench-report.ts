// SciBench v1 bridge (v1.55 unit 2): feed recorded sessions through the same deterministic rules
// and print a scorecard that can be pasted into a review or a release note.
//
// Honesty notes baked in:
//   * the adapter only uses what the recording actually contains — if a session did not record tool
//     calls, the tool-based rules fail rather than being skipped, so a passing score never rests on
//     missing evidence;
//   * the scorecard always states the case count, the rule outcomes and the exact reasons.

import type { SciBenchResult } from './sci-bench'
import type { SciBenchTrace } from './sci-bench'

export type RecordedSessionSlice = {
  /** Messages in the order they happened. */
  messages: { role: 'user' | 'assistant'; text: string }[]
  /** Artifact paths produced by the session, when the recording has them. */
  artifacts?: string[]
  /** Tool invocations with their order preserved. */
  toolCalls?: { name: string; args?: Record<string, unknown> }[]
}

// The transcript keeps the speaker and the order, because several rules are position-sensitive
// (checkpoint_load before the first heavy step) or wording-sensitive.
export const toSciBenchTrace = (slice: RecordedSessionSlice): SciBenchTrace => ({
  transcript: slice.messages
    .map((message) => `${message.role === 'user' ? '用户' : '助手'}：${message.text.trim()}`)
    .join('\n'),
  artifacts: slice.artifacts ?? [],
  toolCalls: (slice.toolCalls ?? []).map((call) => ({ name: call.name, args: call.args }))
})

export type SciBenchScorecardMeta = {
  sessionId?: string
  generatedAt?: string
  /** Where the trace came from (file path, session store) so a reviewer can re-run it. */
  source?: string
}

export const formatSciBenchScorecard = (
  results: readonly SciBenchResult[],
  meta: SciBenchScorecardMeta = {}
): string => {
  const passed = results.filter((result) => result.passed).length
  const failed = results.filter((result) => !result.passed)
  const lines: string[] = ['# SciBench-Local 记分卡', '']

  const context: string[] = []
  if (meta.sessionId) context.push(`会话：${meta.sessionId}`)
  if (meta.source) context.push(`来源：${meta.source}`)
  if (meta.generatedAt) context.push(`生成时间：${meta.generatedAt}`)
  if (context.length > 0) lines.push(...context, '')

  lines.push(`合计：${passed}/${results.length} 通过`, '')

  lines.push('## 结果', '')
  lines.push('| 用例 | 结果 | 未通过的规则 |', '| --- | --- | --- |')
  for (const result of results) {
    const failing = result.findings.filter((finding) => !finding.passed)
    lines.push(
      `| ${result.caseId} | ${result.passed ? '✅ 通过' : '❌ 未通过'} | ${
        failing.length === 0 ? '—' : failing.map((finding) => finding.rule).join('<br>')
      } |`
    )
  }
  lines.push('')

  if (failed.length > 0) {
    lines.push('## 未通过原因', '')
    for (const result of failed) {
      lines.push(`### ${result.caseId}`)
      for (const finding of result.findings.filter((entry) => !entry.passed)) {
        lines.push(`- \`${finding.rule}\`：${finding.detail}`)
      }
      lines.push('')
    }
  }

  lines.push(
    '> 规则是确定性判定：无法从录制内容证实的规则会判未通过，而不是跳过——分数不会因证据缺失而偏高。'
  )
  return `${lines.join('\n').trimEnd()}\n`
}
