// 「方法即产物」：把一次已记录的 notebook 运行编译成一份技能草稿。
//
// 方法是**记录本身**，不是 agent 对它的回忆：这一层只读应用自己落盘的那一条 run 记录，正文、
// 证据、知识种类、来源指纹全部由记录推导。为此编译是一个纯函数，并把配方公开出去：
//   · 来源可追：草稿带着运行的身份证（runId / cellId）与一份第三方可**复算**的指纹（见
//     METHOD_SKILL_RECIPE），所以「这个技能是哪次运行教的」可以被核对，而不是只能被相信；
//   · 编译可复现：同一条记录编译两次得到**逐字节相同**的正文 —— 正文里不进时间、不进数据根的
//     绝对路径，于是对比两次编译对比的是方法本身，不是时钟；
//   · 缺态具名：记录里没有源码 / 运行还没落定 / 记录已被改写 / 文本超出技能文档上限，是四件不同
//     的事 —— 只有一件是用户该去修的，所以它们各有各的名字，绝不合写成一句「编译不了」。
//
// 指纹**不进正文**：正文里的来源块引用指纹、而指纹又覆盖正文，两者互为引用会成环。指纹只落在
// 文档的 frontmatter 证据字段与这里返回的 evidence 里（`SkillCreator` 会把它写进去），于是
// 「hash(instructions)」这句话对第三方是字面可复算的。
//
// 不做的事（具名）：这里从不「润色」源码、不补全缺失的步骤、也不把一次失败的运行说成一条可行流程
// —— 运行没成功时它编译成 `failure-mode`（连同复现它的那段错误），这正是本仓既有的知识语义。
import { createHash } from 'node:crypto'

import type { NotebookRunRecord } from '../../shared/notebook'
import {
  SKILL_CREATE_MAX_DESCRIPTION_LENGTH,
  SKILL_CREATE_MAX_EVIDENCE,
  SKILL_CREATE_MAX_EVIDENCE_LENGTH,
  SKILL_CREATE_MAX_INSTRUCTIONS_LENGTH
} from '../../shared/skill-create'
import type { SkillKnowledgeKind, SkillProvenance } from '../../shared/skill-provenance'
import { notebookRunSourceHash } from '../notebook/run-risk-receipt'

// 配方版本进了指纹前缀：换了分量表就必须抬版本，否则两版对同一条记录算出的值会被拿去相比，
// 而那只会得到「不一致」这种假结论。
export const METHOD_SKILL_RECIPE_VERSION = 'v1'
export const METHOD_SKILL_FINGERPRINT_PREFIX = `method-skill:${METHOD_SKILL_RECIPE_VERSION}-`

// 公开发布出去的配方原文。第三方照着它手写一遍就该得到同一个值 —— 测试里有一条**独立实现**
// （不调本模块的任何助手）来证明这句话，而不是证明「它等于它自己」。
export const METHOD_SKILL_RECIPE =
  `${METHOD_SKILL_FINGERPRINT_PREFIX} + hex(sha256(` +
  [
    METHOD_SKILL_RECIPE_VERSION,
    '<runId>',
    '<cellId>',
    '<kernelKind>',
    '<sha256 of the cell source>',
    '<executionCount | "not-recorded">',
    '<status>',
    '<sha256 of the compiled instructions>'
  ].join('\\0') +
  '))'

// 编译只读这些字段：把依赖写窄是为了让「记录里改了什么会改变产物」一眼可见（例如运行时刻、
// 内核进程状态都不在表里 —— 它们不是方法的一部分）。
export type MethodRunRecord = Pick<
  NotebookRunRecord,
  | 'runId'
  | 'cellId'
  | 'kernelKind'
  | 'script'
  | 'status'
  | 'text'
  | 'workingFiles'
  | 'riskReview'
  | 'executionCount'
  | 'environment'
  | 'truncated'
>

export type MethodSkillRefusalReason =
  // 记录里没有源码：空单元不是一条方法（编出一份「什么都没做」的步骤比拒绝更坏）。
  | 'no-steps'
  // 运行还没落定（还在跑）：记录此刻仍会被改写，编译出来的正文不能声称是它。
  | 'unsettled-run'
  // 单元文本已不是当初被审阅过的那一份（与它自己的风险收据对不上）。
  | 'source-changed'
  // 推导出的正文超出技能文档的上限：宁可具名拒绝，也不静默截断一条方法。
  | 'too-long'

export type MethodSkillDraft = {
  name: string
  description: string
  instructions: string
  kind: SkillKnowledgeKind
  evidence: string[]
  provenance: SkillProvenance
  fingerprint: string
  sourceHash: string
  // 源码哈希的来源：`receipt` = 运行时的风险收据自己算的；`computed-on-read` = 记录早于收据，
  // 按收据自己的哈希函数补算。两态分开命名，证据行就不会把后者读成「当时审过」。
  sourceHashProvenance: 'receipt' | 'computed-on-read'
}

export type MethodSkillCompileResult =
  | { state: 'compiled'; draft: MethodSkillDraft }
  | { state: 'refused'; reason: MethodSkillRefusalReason; detail: string }

// 运行终态里哪些是「这条方法确实跑完过」。queued/running 之外都算落定 —— 失败也是落定（它教的是
// 一条不能走的路，记成 failure-mode 仍然有价值，前提是它带着复现）。
const SETTLED_STATUSES: readonly NotebookRunRecord['status'][] = [
  'completed',
  'failed',
  'timeout',
  'interrupted',
  'cancelled'
]

const OUTPUT_BUDGET = 4_000

// 围栏长度按正文里最长的一串反引号来定：源码里本来含有 ``` 时，固定的三连反引号会让围栏提前闭合，
// 于是技能正文展示的「代码」就不再是那段代码了。
const fenceFor = (body: string): string => {
  let longest = 0
  for (const run of body.match(/`+/g) ?? []) longest = Math.max(longest, run.length)
  return '`'.repeat(Math.max(3, longest + 1))
}

const truncate = (text: string, budget: number): string =>
  text.length <= budget
    ? text
    : `${text.slice(0, budget)}\n… (truncated here: ${text.length - budget} more characters are in the run record)`

const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`

// 把「这次运行留下了什么」写成几行 —— 文件只取记录里的**相对**路径，绝对路径不进技能正文
// （否则一份技能会在另一台机器上指向一个不存在的位置，而它看起来仍然很具体）。
const describeProduced = (run: MethodRunRecord): string[] => {
  const written = run.workingFiles
    .filter((file) => file.changeKind === 'created' || file.changeKind === 'modified')
    .map((file) => file.relativePath?.trim() ?? '')
    .filter((path) => path.length > 0 && !path.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(path))
  const outputs = [
    run.text.stdout.trim() ? `### stdout\n${run.text.stdout.trim()}` : '',
    run.text.stderr.trim() ? `### stderr\n${run.text.stderr.trim()}` : '',
    run.text.traceback.trim() ? `### traceback\n${run.text.traceback.trim()}` : ''
  ].filter((section) => section.length > 0)

  const lines: string[] = []
  lines.push(outputs.length === 0 ? 'No output was recorded for this run.' : truncate(outputs.join('\n\n'), OUTPUT_BUDGET))
  if (written.length > 0) {
    lines.push(`\nFiles this run wrote:\n${written.map((path) => `- ${path}`).join('\n')}`)
  }
  return lines
}

const buildInstructions = (input: {
  name: string
  description: string
  run: MethodRunRecord
  sourceHash: string
}): string => {
  const { name, description, run, sourceHash } = input
  const fence = fenceFor(run.script)
  const environment = run.environment?.trim()
  const lines = [
    `# ${name}`,
    '',
    description,
    '',
    '## What was run',
    '',
    `A recorded \`${run.kernelKind}\` cell${environment ? ` in the \`${environment}\` environment` : ''} (run \`${run.runId}\`, cell \`${run.cellId}\`, execution #${run.executionCount ?? 'not-recorded'}, status \`${run.status}\`).`,
    'The steps below are the cell exactly as it ran; nothing has been paraphrased.',
    '',
    `${fence}${run.kernelKind === 'python' ? 'python' : run.kernelKind === 'r' ? 'r' : 'sh'}`,
    run.script.trim(),
    fence,
    '',
    '## What it produced',
    '',
    ...describeProduced(run),
    '',
    '## Where this came from',
    '',
    `- recipe: ${METHOD_SKILL_RECIPE}`,
    `- run: ${run.runId} (cell ${run.cellId}, ${run.status})`,
    `- source sha256: ${sourceHash}`
  ]
  if (run.truncated) {
    // 记录自己的截断标志如实进正文：一份被截断的记录编出来的步骤不该看起来像完整的。
    lines.push(
      '- the recorded output was truncated by the notebook history window; read the session record for the rest'
    )
  }
  return lines.join('\n')
}

const buildEvidence = (input: {
  run: MethodRunRecord
  sourceHash: string
  sourceHashProvenance: 'receipt' | 'computed-on-read'
  fingerprint: string
}): string[] => {
  const { run, sourceHash, sourceHashProvenance, fingerprint } = input
  const items = [
    `recipe: ${METHOD_SKILL_RECIPE}`,
    `fingerprint: ${fingerprint}`,
    `run: ${run.runId} / cell ${run.cellId} / ${run.kernelKind} / ${run.status}`,
    `source sha256: ${sourceHash} (${sourceHashProvenance === 'receipt' ? 'from the run risk receipt' : 'recomputed on read'})`
  ]
  const error = run.text.traceback.trim() || run.text.stderr.trim()
  if (error) items.push(`error: ${error.split('\n').slice(0, 4).join(' ')}`)
  return items
    .slice(0, SKILL_CREATE_MAX_EVIDENCE)
    .map((item) => clip(item.replace(/\s+/g, ' ').trim(), SKILL_CREATE_MAX_EVIDENCE_LENGTH))
}

/**
 * 把一条已落定的运行记录编译成技能草稿。纯函数：同样的记录 → 逐字节相同的正文与同一个指纹。
 */
export const compileMethodSkill = (input: {
  run: MethodRunRecord
  name: string
  description?: string
}): MethodSkillCompileResult => {
  const { run } = input
  const script = run.script.trim()

  if (script.length === 0) {
    return {
      state: 'refused',
      reason: 'no-steps',
      detail:
        'The recorded run has no cell source to compile: an empty cell is not a method. Run the steps first, then save them.'
    }
  }
  if (!SETTLED_STATUSES.includes(run.status)) {
    return {
      state: 'refused',
      reason: 'unsettled-run',
      detail: `The run is still \`${run.status}\`: the record can still change, so it cannot be the source of a method yet.`
    }
  }

  // 收据是「这一段被审阅过」的那份凭据：文本与它不再对得上时，方法已经不是被批准的那一个。
  // 没有收据的记录（早于收据的版本）不算被改写 —— 它只是没被审过，这一点由证据行如实说出来。
  const receiptHash = run.riskReview?.codeHash
  const computedHash = notebookRunSourceHash(script)
  const hasReceipt = typeof receiptHash === 'string' && receiptHash.length > 0
  if (hasReceipt && receiptHash !== computedHash) {
    return {
      state: 'refused',
      reason: 'source-changed',
      detail:
        'The cell text no longer matches the hash in the run risk receipt, so this record is not the method that was reviewed. Re-run the cell and compile that run.'
    }
  }
  const sourceHash = hasReceipt ? receiptHash : computedHash
  const sourceHashProvenance: 'receipt' | 'computed-on-read' = hasReceipt ? 'receipt' : 'computed-on-read'

  const name = input.name.trim()
  const description =
    input.description?.trim() ||
    clip(
      `Runs the recorded ${run.kernelKind} cell from run ${run.runId}.`,
      SKILL_CREATE_MAX_DESCRIPTION_LENGTH
    )

  const instructions = buildInstructions({ name, description, run: { ...run, script }, sourceHash })
  if (instructions.length > SKILL_CREATE_MAX_INSTRUCTIONS_LENGTH) {
    return {
      state: 'refused',
      reason: 'too-long',
      detail: `The compiled method is ${instructions.length} characters, over the ${SKILL_CREATE_MAX_INSTRUCTIONS_LENGTH}-character skill limit. Split the cell, or keep the method as a reference instead.`
    }
  }

  // 指纹覆盖正文，而正文**不含**指纹（见文件头）：没有环，第三方按配方逐字复算即可。
  const fingerprint = `${METHOD_SKILL_FINGERPRINT_PREFIX}${createHash('sha256')
    .update(
      [
        METHOD_SKILL_RECIPE_VERSION,
        run.runId,
        run.cellId,
        run.kernelKind,
        sourceHash,
        run.executionCount === undefined ? 'not-recorded' : String(run.executionCount),
        run.status,
        createHash('sha256').update(instructions, 'utf8').digest('hex')
      ].join('\0'),
      'utf8'
    )
    .digest('hex')}`

  const kind: SkillKnowledgeKind = run.status === 'completed' ? 'procedure' : 'failure-mode'
  const evidence = buildEvidence({ run, sourceHash, sourceHashProvenance, fingerprint })
  return {
    state: 'compiled',
    draft: {
      name,
      description,
      instructions,
      kind,
      evidence,
      provenance: {
        kind,
        // 新建的草稿一律 unverified：编译证明的是「这条方法来自那次运行」，不是「它还成立」。
        verification: 'unverified',
        originRunId: run.runId,
        evidence
      },
      fingerprint,
      sourceHash,
      sourceHashProvenance
    }
  }
}
