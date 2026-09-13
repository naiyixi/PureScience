// Skill reuse ledger (C1).
//
// The app already records which skills were attached to each turn: every attachment is emitted as a
// 'tool' activity named 'Loaded skill: <name>' whose call id carries the turn. So the reuse chain -
// which run used which skill, and whether that use failed - is derivable from the activity stream the
// sessions already persist. No new collection, no new IPC channel.
//
// This is the usage side of the ledger; the trust side (verification state, origin run, evidence) lives
// on the skill itself (see shared/skill-provenance).

const SKILL_TITLE_PREFIX = 'Loaded skill: '
const SKILL_CALL_PREFIX = 'purescience-skill-'

export type SkillUsageStatus = 'in_progress' | 'completed' | 'failed'

export type SkillUsage = {
  skillName: string
  /** The prompt turn the skill was attached to, or undefined when the call id does not carry one. */
  turn?: number
  status: SkillUsageStatus
  activityId: string
}

/** Structured view of a persisted activity, so this stays decoupled from the session-persistence type. */
export type SkillUsageActivityLike = {
  id: string
  status: string
  providerToolName?: string
  title?: string
}

const statusOf = (value: string): SkillUsageStatus => {
  if (value === 'failed') return 'failed'
  if (value === 'in_progress') return 'in_progress'
  return 'completed'
}

const turnFromCallId = (id: string): number | undefined => {
  if (!id.startsWith(SKILL_CALL_PREFIX)) return undefined
  const turn = Number.parseInt(id.slice(SKILL_CALL_PREFIX.length), 10)
  return Number.isInteger(turn) ? turn : undefined
}

/**
 * The skill attachments in one activity list, oldest first. Identified by the title prefix the emitter
 * writes rather than by tool name alone: the provider has a native Skill tool whose name differs, and
 * only the app's own emission carries the loaded skill's name.
 */
export const skillUsagesFromActivities = (
  activities: readonly SkillUsageActivityLike[]
): SkillUsage[] =>
  activities.flatMap((activity) => {
    const title = activity.title ?? ''
    if (!title.startsWith(SKILL_TITLE_PREFIX)) return []
    const skillName = title.slice(SKILL_TITLE_PREFIX.length).trim()
    if (skillName.length === 0) return []
    const turn = turnFromCallId(activity.id)
    return [
      {
        skillName,
        ...(turn === undefined ? {} : { turn }),
        status: statusOf(activity.status),
        activityId: activity.id
      }
    ]
  })

export type SkillPayoff = {
  skillName: string
  /** How many times the skill was attached (completed or failed). */
  uses: number
  /** How many of those attachments failed. */
  failures: number
  /** Highest turn seen, so a caller can tell recent use from old use. */
  lastTurn?: number
}

/**
 * Per-skill use counts, most used first. A skill with zero uses simply cannot appear here — that is the
 * honest reading, and a panel must say "no reuse recorded" rather than invent a ranking.
 */
export const summarizeSkillUsage = (usages: readonly SkillUsage[]): SkillPayoff[] => {
  const bySkill = new Map<string, SkillPayoff>()
  for (const usage of usages) {
    const entry = bySkill.get(usage.skillName) ?? {
      skillName: usage.skillName,
      uses: 0,
      failures: 0
    }
    entry.uses += 1
    if (usage.status === 'failed') entry.failures += 1
    if (usage.turn !== undefined) {
      entry.lastTurn = Math.max(entry.lastTurn ?? usage.turn, usage.turn)
    }
    bySkill.set(usage.skillName, entry)
  }
  return [...bySkill.values()].sort(
    (left, right) => right.uses - left.uses || left.skillName.localeCompare(right.skillName)
  )
}
