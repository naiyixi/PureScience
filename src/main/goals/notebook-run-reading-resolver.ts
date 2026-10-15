// F2 的生产侧读数解析器：把「这条读数真的存在吗」落到**应用自己的 notebook 运行记录**上
// （`<storageRoot>/<项目>/<会话>/run.json`）。
//
// 两条纪律写在这里，因为它们决定了这个文件该长什么样：
//  ① **读记录用产品自己的仓储**（`NotebookRunRepository.findExisting`：路径编码、`$DATA` 解码与归一化都在
//     它里面），不自己 `JSON.parse` —— 否则「解析器读得懂真实记录」这件事根本没被验到；
//  ② **指纹用收据自己的哈希函数**（`notebookRunSourceHash`，风险收据也在用它）—— 绝不第二份实现，
//     否则同一个运行会有两个都能自称权威的哈希。

import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { NOTEBOOKS_DIR, NotebookRunRepository } from '../notebook/repository'
import { notebookRunSourceHash } from '../notebook/run-risk-receipt'
import type { GoalReadingResolution, GoalReadingResolver } from './goal-repository'

type SessionLocation = {
  projectName: string
  sessionId: string
}

// Only run readings are wired this version. The other kinds are named rather than guessed: a resolver that
// answered "found" for an artifact version it cannot look up would be inventing the reading.
const UNWIRED_KINDS = new Set(['artifact-version', 'connector-reading'])

// The repository's own constant, not a re-typed 'notebooks': the scan has to look where the writer writes.
const listSessions = async (dataRoot: string): Promise<SessionLocation[]> => {
  const sessions: SessionLocation[] = []
  const notebooksRoot = join(dataRoot, NOTEBOOKS_DIR)
  let projects: string[]
  try {
    projects = await readdir(notebooksRoot)
  } catch {
    return sessions
  }
  for (const projectName of projects) {
    if (projectName.startsWith('.')) continue
    let children: string[]
    try {
      children = await readdir(join(notebooksRoot, projectName))
    } catch {
      continue
    }
    for (const sessionId of children) {
      if (sessionId.startsWith('.')) continue
      sessions.push({ projectName, sessionId })
    }
  }
  return sessions
}

export const createNotebookRunReadingResolver = (options: {
  storageRoot: string
}): GoalReadingResolver => {
  const repository = new NotebookRunRepository(options.storageRoot)

  return {
    async resolve(ref, context): Promise<GoalReadingResolution> {
      if (UNWIRED_KINDS.has(ref.kind)) {
        return { ok: false, reason: 'not-found' }
      }

      const sessions = await listSessions(options.storageRoot)
      const sources = [
        ...sessions.filter((location) => location.sessionId === context.sessionId),
        ...sessions.filter((location) => location.sessionId !== context.sessionId)
      ]

      for (const location of sources) {
        let document
        try {
          document = await repository.findExisting(location.projectName, location.sessionId)
        } catch {
          // A session whose record will not read is skipped rather than treated as "no runs": the loop
          // would otherwise report `not-found` for a reading that may well exist in a torn file.
          continue
        }
        const run = document?.runs.find((candidate) => candidate.runId === ref.id)
        if (!run) continue

        const fingerprint = notebookRunSourceHash(run.script)
        // Found — but in someone else's session, and a reading is only evidence for the session that owns it.
        if (location.sessionId !== context.sessionId) {
          return { ok: false, reason: 'foreign-session' }
        }
        if (fingerprint !== ref.fingerprint) {
          return { ok: false, reason: 'fingerprint-mismatch' }
        }
        return { ok: true, fingerprint }
      }

      return { ok: false, reason: 'not-found' }
    }
  }
}
