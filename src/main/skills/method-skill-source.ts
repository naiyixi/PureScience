// 技能编译器的**来源层**：这条方法的那条记录，从应用自己的落盘里取。
//
// 「方法即产物」这句承诺只在来源是应用自己的记录时才成立，所以这里从不接受调用方给出的代码、
// 也不接受一条「大概是这次运行」的近似匹配：给定会话 + runId 就去翻该项目自己的 run.json。
// 找不到时**不许**回一份空记录，而要具名（`not-found`）—— 一份空记录会被编译器理解成
// 「这次运行什么都没做」，那是另一个意思。
//
// 已知边界（具名，不假装更精确）：会话 → 项目要从项目清单里逐个项目试读，因为 run.json 的路径
// 含项目 id 而 RPC 只带来会话 id。同一个 runId 在多个项目里都存在时答案不唯一 ⇒ `ambiguous`，
// 宁可不猜。
import type { NotebookRunRecord } from '../../shared/notebook'
import type { NotebookRunRepository } from '../notebook/repository'

export type MethodRunSourceOutcome =
  | { state: 'found'; projectId: string; run: NotebookRunRecord; documentRunCount: number }
  | {
      state: 'missing'
      reason: 'not-found' | 'ambiguous'
      detail: string
      // 读了几份、几份读不了：`not-found` 是对「读得到的那些」的断言，读不到的必须一起说出来，
      // 否则一份读失败的记录会与「确实没有」同形。
      lookedAt: { projects: number; unreadable: number }
    }

export const readMethodRunSource = async (options: {
  repository: Pick<NotebookRunRepository, 'findExisting'>
  listProjectIds: () => Promise<readonly string[]>
  sessionId: string
  runId: string
}): Promise<MethodRunSourceOutcome> => {
  const { repository, listProjectIds, sessionId, runId } = options
  const projectIds = await listProjectIds()

  const matches: { projectId: string; run: NotebookRunRecord; documentRunCount: number }[] = []
  let unreadable = 0
  for (const projectId of projectIds) {
    let document: Awaited<ReturnType<NotebookRunRepository['findExisting']>>
    try {
      document = await repository.findExisting(projectId, sessionId)
    } catch {
      // 项目 id 形状不合法 / 记录损坏：算「读不到」，不算「没有」。
      unreadable += 1
      continue
    }
    if (!document) continue
    const run = document.runs.find((candidate) => candidate.runId === runId)
    if (run) matches.push({ projectId, run, documentRunCount: document.runs.length })
  }

  if (matches.length > 1) {
    return {
      state: 'missing',
      reason: 'ambiguous',
      detail: `Run ${runId} exists in ${matches.length} projects (${matches.map((match) => match.projectId).join(', ')}). Refusing to guess which one the method came from.`,
      lookedAt: { projects: projectIds.length, unreadable }
    }
  }
  if (matches.length === 1) {
    const match = matches[0]
    return {
      state: 'found',
      projectId: match.projectId,
      run: match.run,
      documentRunCount: match.documentRunCount
    }
  }

  const unreadableNote =
    unreadable > 0 ? ` (${unreadable} of ${projectIds.length} project records could not be read)` : ''
  return {
    state: 'missing',
    reason: 'not-found',
    detail: `Run ${runId} is not in session ${sessionId} for any of the ${projectIds.length} projects that could be read${unreadableNote}.`,
    lookedAt: { projects: projectIds.length, unreadable }
  }
}
