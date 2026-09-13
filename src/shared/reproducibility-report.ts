import type {
  ArtifactReproducibilityReport,
  ReproducibilityEvidenceKind,
  ReproducibilityVerdict
} from './reproducibility'

// Batch reproduction scorecard.
//
// The aggregation is the same honesty boundary as the per-Version verdict, one level up: a batch is
// `verified` only when EVERY checked Version was reproduced by the app's own re-execution. One failure
// fails the batch, and anything unjudged keeps it partial — no averaging, no "mostly reproduced".

export const REPRODUCIBILITY_MAX_BATCH_VERSIONS = 20

export type ReproducibilityBatchEntry = {
  label: string
  artifactId: string
  versionId: string
  verdict: ReproducibilityVerdict
  evidenceKind: ReproducibilityEvidenceKind
  counts: {
    compared: number
    identical: number
    mismatched: number
    notCompared: number
  }
  requiredLabels: string[]
  replayState?: string
  // Set when the check itself could not complete (unknown Version, transport failure): the batch keeps
  // the Version visible as not-checkable instead of dropping it and reporting a smaller, greener run.
  detail?: string
}

export type ReproducibilityBatchStatus = 'verified' | 'failed' | 'partial' | 'not-checkable'

export type ReproducibilityBatchSummary = {
  total: number
  reproduced: number
  bytesMatch: number
  notReproduced: number
  inconclusive: number
  notCheckable: number
  status: ReproducibilityBatchStatus
  requiredLabels: string[]
  reasons: string[]
}

const countByVerdict = (
  entries: readonly ReproducibilityBatchEntry[],
  verdict: ReproducibilityVerdict
): number => entries.filter((entry) => entry.verdict === verdict).length

export const summarizeReproducibilityBatch = (
  entries: readonly ReproducibilityBatchEntry[]
): ReproducibilityBatchSummary => {
  const reproduced = countByVerdict(entries, 'reproduced')
  const bytesMatch = countByVerdict(entries, 'bytes-match')
  const notReproduced = countByVerdict(entries, 'not-reproduced')
  const inconclusive = countByVerdict(entries, 'inconclusive')
  const notCheckable = countByVerdict(entries, 'not-checkable')
  const requiredLabels: string[] = []
  const reasons: string[] = []

  if (entries.length === 0) {
    return {
      total: 0,
      reproduced: 0,
      bytesMatch: 0,
      notReproduced: 0,
      inconclusive: 0,
      notCheckable: 0,
      status: 'not-checkable',
      requiredLabels: ['no-versions-checked'],
      reasons: ['no-versions-checked']
    }
  }

  if (bytesMatch > 0) requiredLabels.push('batch-contains-bytes-match')
  if (inconclusive > 0) requiredLabels.push('batch-contains-inconclusive')
  if (notCheckable > 0) requiredLabels.push('batch-contains-not-checkable')
  for (const entry of entries) {
    if (entry.verdict !== 'reproduced') reasons.push(`${entry.label}:${entry.verdict}`)
  }

  const status: ReproducibilityBatchStatus =
    reproduced === entries.length
      ? 'verified'
      : notReproduced > 0
        ? 'failed'
        : notCheckable === entries.length
          ? 'not-checkable'
          : 'partial'

  if (status !== 'verified') requiredLabels.push('batch-not-verified')

  return {
    total: entries.length,
    reproduced,
    bytesMatch,
    notReproduced,
    inconclusive,
    notCheckable,
    status,
    requiredLabels,
    reasons
  }
}

export const toReproducibilityBatchEntry = ({
  label,
  artifactId,
  versionId,
  report
}: {
  label: string
  artifactId: string
  versionId: string
  report: ArtifactReproducibilityReport
}): ReproducibilityBatchEntry => ({
  label,
  artifactId,
  versionId,
  verdict: report.verdict,
  evidenceKind: report.evidenceKind,
  counts: report.counts,
  requiredLabels: report.requiredLabels,
  ...(report.replay?.execution ? { replayState: report.replay.execution.state } : {})
})

const verdictCell = (verdict: ReproducibilityVerdict): string => {
  switch (verdict) {
    case 'reproduced':
      return '✅ 重跑复现'
    case 'bytes-match':
      return '🟡 仅字节一致（未重跑）'
    case 'not-reproduced':
      return '❌ 未复现'
    case 'inconclusive':
      return '⚠️ 无法判定'
    default:
      return '⬜ 不可校验'
  }
}

const statusHeadline = (status: ReproducibilityBatchStatus): string => {
  switch (status) {
    case 'verified':
      return '✅ 全部由应用重跑复现'
    case 'failed':
      return '❌ 存在未复现的产物'
    case 'partial':
      return '⚠️ 部分判定（含仅字节一致 / 无法判定）'
    default:
      return '⬜ 不可校验（配方未封存或无可评分产物）'
  }
}

export const formatReproducibilityScorecard = (
  entries: readonly ReproducibilityBatchEntry[],
  meta: { sessionId?: string; generatedAt?: string } = {}
): string => {
  const summary = summarizeReproducibilityBatch(entries)
  const lines: string[] = ['# 产物复现校验记分卡', '']

  const context: string[] = []
  if (meta.sessionId) context.push(`会话：${meta.sessionId}`)
  if (meta.generatedAt) context.push(`生成时间：${meta.generatedAt}`)
  if (context.length > 0) lines.push(...context, '')

  lines.push(
    `合计：${summary.reproduced}/${summary.total} 重跑复现 · 结论：${statusHeadline(summary.status)}`,
    ''
  )
  lines.push(
    `判定分布：重跑复现 ${summary.reproduced} · 仅字节一致 ${summary.bytesMatch} · 未复现 ${summary.notReproduced} · 无法判定 ${summary.inconclusive} · 不可校验 ${summary.notCheckable}`,
    ''
  )
  lines.push('## 逐产物结果', '')
  lines.push(
    '| 产物 | 判定 | 证据 | 比对（一致/不一致/未比） | 重放 | 标签 |',
    '| --- | --- | --- | --- | --- | --- |'
  )
  for (const entry of entries) {
    lines.push(
      `| ${entry.label} | ${verdictCell(entry.verdict)} | ${
        entry.evidenceKind === 'app-reexecution'
          ? '应用重跑'
          : entry.evidenceKind === 'external-bytes'
            ? '外部字节'
            : '无'
      } | ${entry.counts.identical}/${entry.counts.mismatched}/${entry.counts.notCompared} | ${
        entry.replayState ?? '—'
      } | ${entry.requiredLabels.length === 0 ? '—' : entry.requiredLabels.join('<br>')} |`
    )
  }
  lines.push('')

  if (summary.reasons.length > 0) {
    lines.push('## 未判定为复现的产物', '')
    lines.push(...summary.reasons.map((reason) => `- ${reason}`), '')
  }

  const failedChecks = entries.filter((entry) => entry.detail)
  if (failedChecks.length > 0) {
    lines.push('## 检查未完成的产物', '')
    lines.push(...failedChecks.map((entry) => `- ${entry.label}：${entry.detail}`), '')
  }

  lines.push(
    '> 口径：只有应用自己在隔离目录内重跑过、且每个比对文件一致，才计为「重跑复现」；调用方递回的字节一致一律记为「仅字节一致」；同批中任一产物未复现即判定为失败，未判定项不会因多数通过而被抹平。'
  )

  return lines.join('\n')
}
