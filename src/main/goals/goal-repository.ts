// 目标的持久化：`goal_configure` / `goal_status` 背后的存储。形状照 routine 的仓储（同一套「主进程是唯一
// 写者 + 原子写（temp + rename）+ 路径守卫 + 具名错误码」），因为这两件事的失败方式完全一样：一次崩在
// 写一半上，留下的必须仍是**上一份完整记录**，而不是一个读不回来的半截文件。
//
// 目标与 routine 的分工：routine 回答「什么时候再跑一次」，目标回答「这件事做完没有、凭什么说做完了」。
// 所以目标里最重要的字段不是 objective，而是每条验收项上那个 `metBy` —— 它是**读数引用**，空着就等于
// 「还没被任何一次真实运行证明过」。

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join, relative, resolve, sep } from 'node:path'

import type { Goal, GoalAcceptanceItem, GoalRefusalCode, GoalState } from '../../shared/goal'
import {
  GOAL_MAX_ACCEPTANCE_ITEMS,
  GOAL_MAX_OBJECTIVE_CHARS,
  GOAL_MAX_TEXT_CHARS
} from '../../shared/goal'

const GOALS_DIR = '.goals'
const GOALS_FILE = 'goals.json'

export class GoalValidationError extends Error {
  readonly code: GoalRefusalCode

  constructor(code: GoalRefusalCode, message: string) {
    super(message)
    this.name = 'GoalValidationError'
    this.code = code
  }
}

export type GoalConfigureRequest = {
  sessionId: string
  goalId?: string
  objective: string
  acceptance: string[]
}

export type GoalStoreSnapshot = {
  goals: Goal[]
}

// The same shape as the routine store's: under the session's own artifacts directory, so a goal lives and
// dies with the session it belongs to, and a key that escapes that directory throws instead of writing.
export const resolveGoalsRoot = (root: string, sessionId: string): string => {
  const candidate = resolve(root, 'artifacts', encodeURIComponent(sessionId), GOALS_DIR)
  const fromRoot = relative(resolve(root), candidate)
  if (!fromRoot || fromRoot === '..' || fromRoot.startsWith(`..${sep}`)) {
    throw new Error('Invalid goal storage key.')
  }
  return candidate
}

const nonEmpty = (value: unknown): string | null => {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

export class GoalRepository {
  private readonly root: string
  private readonly now: () => number

  constructor(options: { root: string; now?: () => number }) {
    this.root = options.root
    this.now = options.now ?? (() => Date.now())
  }

  private pathFor(sessionId: string): string {
    return join(resolveGoalsRoot(this.root, sessionId), GOALS_FILE)
  }

  // Reads what is there. A missing file is an empty store (nobody has registered a goal yet); a file that
  // will not parse is named, never silently treated as empty — "I could not read it" and "there is nothing"
  // lead to different actions, and only one of them is safe to act on.
  async load(sessionId: string): Promise<GoalStoreSnapshot> {
    const path = this.pathFor(sessionId)
    let raw: string
    try {
      raw = await readFile(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { goals: [] }
      throw new GoalValidationError('record-unreadable', 'The goal record could not be read.')
    }
    try {
      const parsed = JSON.parse(raw) as { goals?: unknown }
      if (!Array.isArray(parsed.goals)) {
        throw new Error('no goals array')
      }
      return { goals: parsed.goals as Goal[] }
    } catch {
      throw new GoalValidationError('record-unreadable', 'The goal record could not be parsed.')
    }
  }

  private async save(sessionId: string, snapshot: GoalStoreSnapshot): Promise<void> {
    const path = this.pathFor(sessionId)
    await mkdir(dirname(path), { recursive: true })
    const temporary = `${path}.${randomUUID()}.tmp`
    await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
    // One rename commits it: a crash before this line leaves the previous file untouched.
    await rename(temporary, path)
  }

  // Registers a goal, or updates the one named by goalId. Updating keeps the criteria that are already met
  // and their readings: re-typing a criterion must not erase the evidence that met it.
  async configure(request: GoalConfigureRequest): Promise<Goal> {
    const objective = nonEmpty(request.objective)
    if (!objective) {
      throw new GoalValidationError('empty-objective', 'A goal needs an objective.')
    }
    if (objective.length > GOAL_MAX_OBJECTIVE_CHARS) {
      throw new GoalValidationError(
        'objective-too-long',
        `An objective is at most ${GOAL_MAX_OBJECTIVE_CHARS} characters.`
      )
    }
    if (!Array.isArray(request.acceptance) || request.acceptance.length === 0) {
      throw new GoalValidationError(
        'no-acceptance',
        'A goal needs at least one acceptance criterion.'
      )
    }
    if (request.acceptance.length > GOAL_MAX_ACCEPTANCE_ITEMS) {
      throw new GoalValidationError(
        'too-many-acceptance',
        `At most ${GOAL_MAX_ACCEPTANCE_ITEMS} acceptance criteria.`
      )
    }
    const criteria: string[] = []
    for (const item of request.acceptance) {
      const text = nonEmpty(item)
      if (!text) {
        throw new GoalValidationError(
          'empty-acceptance-item',
          'An acceptance criterion cannot be empty.'
        )
      }
      if (text.length > GOAL_MAX_TEXT_CHARS) {
        throw new GoalValidationError(
          'acceptance-too-long',
          `An acceptance criterion is at most ${GOAL_MAX_TEXT_CHARS} characters.`
        )
      }
      criteria.push(text)
    }

    const snapshot = await this.load(request.sessionId)
    const at = this.now()
    const existing = request.goalId
      ? snapshot.goals.find((goal) => goal.id === request.goalId)
      : undefined
    if (request.goalId && !existing) {
      throw new GoalValidationError('not-found', `No goal with id ${request.goalId}.`)
    }

    const acceptance: GoalAcceptanceItem[] = criteria.map((text) => {
      const kept = existing?.acceptance.find((item) => item.text === text)
      return kept ? { ...kept, text } : { id: randomUUID(), text, metBy: null }
    })

    const goal: Goal = {
      id: existing?.id ?? randomUUID(),
      sessionId: request.sessionId,
      objective,
      acceptance,
      milestones: existing?.milestones ?? [],
      state: existing?.state ?? ('active' as GoalState),
      createdAt: existing?.createdAt ?? at,
      updatedAt: at
    }

    const goals = existing
      ? snapshot.goals.map((candidate) => (candidate.id === goal.id ? goal : candidate))
      : [...snapshot.goals, goal]
    await this.save(request.sessionId, { goals })
    return goal
  }

  async status(sessionId: string): Promise<Goal[]> {
    const snapshot = await this.load(sessionId)
    return snapshot.goals
  }
}
