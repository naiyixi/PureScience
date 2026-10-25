// 从会话文档里抽 artifact 定位符（轨迹包的 `artifacts.json`）。
//
// 只出**定位符**，不出字节（计划 §2）。来源是消息上已经落盘的 `artifactIds` —— 这是会话文档自己的
// 事实，不需要第二个仓储、也不需要 projectName。
//
// 校验和与 runId 只有在我能真拿到时才写：`artifactIds` 里没有它们，所以这里不写。按「做不到就不打」，
// 一个看起来像证据的 64 位十六进制占位符比缺席更糟。

import type { TrajectoryArtifact } from './bundle-payload'

export const extractArtifacts = (session: unknown): TrajectoryArtifact[] => {
  if (typeof session !== 'object' || session === null) return []
  const messages = (session as { messages?: unknown }).messages
  if (!Array.isArray(messages)) return []

  const seen = new Set<string>()
  const artifacts: TrajectoryArtifact[] = []
  for (const message of messages) {
    if (typeof message !== 'object' || message === null) continue
    const ids = (message as { artifactIds?: unknown }).artifactIds
    if (!Array.isArray(ids)) continue
    for (const id of ids) {
      if (typeof id !== 'string' || id.trim().length === 0) continue
      const artifactVersionId = id.trim()
      if (seen.has(artifactVersionId)) continue
      seen.add(artifactVersionId)
      artifacts.push({ artifactVersionId })
    }
  }
  return artifacts
}
