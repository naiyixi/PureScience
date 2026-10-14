// 「方法即产物」的编排层：来源记录 → 编译 → 落盘（唯一的写入者仍是 `SkillCreator`）。
//
// 三条接线理由：
//   1) 只有**一个**写技能的模块（`SkillCreator`）。这里不自己写 SKILL.md —— 第二份写实现会与它
//      在边界、frontmatter、trust 字段上慢慢分叉，而「哪个是真的」没人说得清；
//   2) 名字/描述仍是调用方的（技能的身份不该由一次运行决定），而正文、证据、知识种类一律**由记录
//      推导** —— 这正是「方法即产物」与「让 agent 复述一遍」的区别；
//   3) 每一种缺态都从这一层出去时**带名字**：来源层给 not-found/ambiguous，纯编译层给
//      no-steps/unsettled-run/source-changed/too-long，写入层给 write-refused（连它自己的原话）。
import type { SkillCreateResult } from '../../shared/skill-create'
import type { SkillKnowledgeKind } from '../../shared/skill-provenance'
import type { NotebookRunRepository } from '../notebook/repository'
import type { SkillCreator } from './skill-creator'
import { compileMethodSkill, type MethodSkillRefusalReason } from './method-skill'
import { readMethodRunSource } from './method-skill-source'

export type MethodSkillCompileOutcome =
  | {
      state: 'created'
      result: SkillCreateResult
      fingerprint: string
      projectId: string
      runId: string
      kind: SkillKnowledgeKind
      // 正文是否真的进了盘：`SkillCreator` 回 created=true 才算，否则走 write-refused 分支。
      skillName: string
    }
  | {
      state: 'refused'
      reason: MethodSkillRefusalReason | 'not-found' | 'ambiguous' | 'write-refused'
      detail: string
    }

export type MethodSkillCompiler = {
  compileFromRun: (input: {
    sessionId: string
    runId: string
    name: string
    description?: string
  }) => Promise<MethodSkillCompileOutcome>
}

export const createMethodSkillCompiler = (deps: {
  skillCreator: Pick<SkillCreator, 'create'>
  repository: Pick<NotebookRunRepository, 'findExisting'>
  listProjectIds: () => Promise<readonly string[]>
}): MethodSkillCompiler => ({
  compileFromRun: async (input) => {
    const runId = input.runId.trim()
    if (runId.length === 0) {
      return { state: 'refused', reason: 'not-found', detail: 'No recorded run was named.' }
    }

    const source = await readMethodRunSource({
      repository: deps.repository,
      listProjectIds: deps.listProjectIds,
      sessionId: input.sessionId,
      runId
    })
    if (source.state === 'missing') {
      return { state: 'refused', reason: source.reason, detail: source.detail }
    }

    const compiled = compileMethodSkill({
      run: source.run,
      name: input.name,
      description: input.description
    })
    if (compiled.state === 'refused') {
      return { state: 'refused', reason: compiled.reason, detail: compiled.detail }
    }

    const { draft } = compiled
    const result = await deps.skillCreator.create({
      name: draft.name,
      description: draft.description,
      instructions: draft.instructions,
      kind: draft.kind,
      evidence: draft.evidence,
      // 来源写进 frontmatter：`trust_origin = <runId>` + 证据行（含配方与指纹），于是这份技能
      // 「从哪来」在导出/导入、materializer 与目录里都还在，不需要第二份数据库。
      provenance: draft.provenance
    })
    if (!result.created) {
      return {
        state: 'refused',
        reason: 'write-refused',
        detail: result.reason ?? 'The skill was not written.'
      }
    }

    return {
      state: 'created',
      result,
      fingerprint: draft.fingerprint,
      projectId: source.projectId,
      runId: source.run.runId,
      kind: draft.kind,
      skillName: result.skillName ?? draft.name
    }
  }
})
