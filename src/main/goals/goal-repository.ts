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

import type {
  Goal,
  GoalAcceptanceItem,
  GoalAdvanceRequest,
  GoalConfigureRequest,
  GoalMilestone,
  GoalReadingRef,
  GoalRefusalCode,
  GoalState
} from '../../shared/goal'
import {
  GOAL_MAX_ACCEPTANCE_ITEMS,
  GOAL_MAX_MILESTONES,
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

export type GoalStoreSnapshot = {
  goals: Goal[]
}

// The seam for「这条读数真的存在吗」. The store does not know how to look a run or an artifact version up —
// the app does — so it asks. Kept as a port so the store's rule ("no resolution, no progress") is testable
// without a running application, while production passes the real adapter.
export type GoalReadingResolution =
  | { ok: true; fingerprint: string }
  | { ok: false; reason: 'not-found' | 'foreign-session' | 'fingerprint-mismatch' }

export type GoalReadingResolver = {
  resolve(ref: GoalReadingRef, context: { sessionId: string }): Promise<GoalReadingResolution>
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
  async configure(sessionId: string, request: GoalConfigureRequest): Promise<Goal> {
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

    const snapshot = await this.load(sessionId)
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
      sessionId: sessionId,
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
    await this.save(sessionId, { goals })
    return goal
  }

  async status(sessionId: string): Promise<Goal[]> {
    const snapshot = await this.load(sessionId)
    return snapshot.goals
  }

  // Advances one criterion — and this is the whole point of the F series: the claim does not win, the
  // app's reading does. The caller names a reading; the resolver goes and gets it; if it cannot, nothing
  // is written. On success the fingerprint stored is the one the RESOLVER computed, not the one the caller
  // sent, so a record can never hold a value that its own re-resolution would contradict.
  async advance(
    sessionId: string,
    request: GoalAdvanceRequest,
    resolver: GoalReadingResolver
  ): Promise<Goal> {
    const readingId = nonEmpty(request.reading?.id)
    if (!readingId) {
      throw new GoalValidationError('empty-reading-id', 'A reading reference needs an id.')
    }
    const claimedFingerprint = nonEmpty(request.reading?.fingerprint)
    if (!claimedFingerprint) {
      throw new GoalValidationError(
        'empty-reading-fingerprint',
        'A reading reference needs the fingerprint it was read with.'
      )
    }

    const snapshot = await this.load(sessionId)
    const goal = snapshot.goals.find((candidate) => candidate.id === request.goalId)
    if (!goal) {
      throw new GoalValidationError('not-found', `No goal with id ${request.goalId}.`)
    }

    // Matched by id first, then by exact text — a caller that re-typed the criterion still lands on it.
    const criterion =
      goal.acceptance.find((item) => item.id === request.criterion) ??
      goal.acceptance.find((item) => item.text === request.criterion)
    if (!criterion) {
      throw new GoalValidationError(
        'criterion-not-found',
        'That goal has no acceptance criterion by that id or text.'
      )
    }

    if (goal.milestones.length >= GOAL_MAX_MILESTONES) {
      throw new GoalValidationError(
        'too-many-milestones',
        `A goal keeps at most ${GOAL_MAX_MILESTONES} milestones.`
      )
    }

    const resolved = await resolver.resolve({ ...request.reading, id: readingId }, { sessionId })
    if (!resolved.ok) {
      if (resolved.reason === 'foreign-session') {
        throw new GoalValidationError(
          'reading-foreign-session',
          'That reading belongs to another session.'
        )
      }
      if (resolved.reason === 'fingerprint-mismatch') {
        throw new GoalValidationError(
          'reading-fingerprint-mismatch',
          'The reading no longer has the fingerprint it was claimed with.'
        )
      }
      throw new GoalValidationError('reading-not-found', 'No such reading.')
    }

    const at = this.now()
    const reading: GoalReadingRef = {
      kind: request.reading.kind,
      id: readingId,
      // The resolver's value, not the caller's.
      fingerprint: resolved.fingerprint
    }
    const milestones: GoalMilestone[] = [
      ...goal.milestones,
      {
        id: randomUUID(),
        text: nonEmpty(request.note) ?? criterion.text,
        at,
        reading
      }
    ]
    const acceptance: GoalAcceptanceItem[] = goal.acceptance.map((item) =>
      item.id === criterion.id ? { ...item, metBy: reading } : item
    )

    const updated: Goal = { ...goal, acceptance, milestones, updatedAt: at }
    const goals = snapshot.goals.map((candidate) =>
      candidate.id === goal.id ? updated : candidate
    )
    await this.save(sessionId, { goals })
    return updated
  }
}
