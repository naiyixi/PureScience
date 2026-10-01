/**
 * Per-target skill availability.
 *
 * The app has two families of skill readers — the agent frameworks it drives and the specialists a session
 * can run as — and until now a skill was either on for everyone or off for everyone. This is the data for
 * "off for this reader only": a target id maps to the skill ids that reader must not load.
 *
 * Two rules live in this file rather than in each caller, because a gate only one path honours is worse than
 * no gate:
 *
 * 1. **Always-on skills cannot be withheld per target either.** The global disabled set already refuses to
 *    hold them (`withoutAlwaysOnSkillIds`); a per-target set that ignored that would be a way around the
 *    gate, which is the same as having no gate.
 * 2. **Unknown targets are dropped, not carried.** A target this build does not know cannot be compared
 *    against anything, and keeping it would make a downgrade's leftovers look like intent.
 */

export type SkillAvailabilityEntry = Readonly<{
  /** Skill ids this target must not load. */
  disabledSkillIds: readonly string[]
}>

export type SkillAvailability = Readonly<Record<string, SkillAvailabilityEntry>>

/**
 * The effective disabled set for one target: what is globally off plus what this target must not load, with
 * always-on skills removed either way. Returned as a set because every consumer only asks membership.
 */
export const skillIdsDisabledForTarget = ({
  availability,
  targetId,
  globalDisabledIds,
  alwaysOnSkillIds
}: {
  availability?: SkillAvailability
  targetId: string
  globalDisabledIds: readonly string[]
  alwaysOnSkillIds: ReadonlySet<string>
}): Set<string> => {
  const withheld = [...globalDisabledIds, ...(availability?.[targetId]?.disabledSkillIds ?? [])]

  return new Set(withheld.filter((id) => id !== '' && !alwaysOnSkillIds.has(id)))
}

const idList = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined
  const ids = [
    ...new Set(value.filter((entry): entry is string => typeof entry === 'string' && entry !== ''))
  ]

  return ids.length === 0 ? undefined : ids
}

/** Reads a stored availability map: malformed targets and empty lists are dropped rather than kept. */
export const sanitizeSkillAvailability = (value: unknown): SkillAvailability | undefined => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined

  const sanitized: Record<string, SkillAvailabilityEntry> = {}
  for (const [targetId, raw] of Object.entries(value as Record<string, unknown>)) {
    if (targetId === '' || typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue
    const ids = idList((raw as { disabledSkillIds?: unknown }).disabledSkillIds)
    if (!ids) continue
    sanitized[targetId] = { disabledSkillIds: ids }
  }

  return Object.keys(sanitized).length === 0 ? undefined : sanitized
}
