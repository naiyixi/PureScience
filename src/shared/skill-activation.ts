// Whether a skill can be switched off at all.
//
// The skills that ship with the app are its gatekeepers: they carry the guarantees the rest of the
// workflow leans on, so switching one off would silently remove a safeguard. The policy is DERIVED from
// the judgement the app already uses everywhere else (`source === 'featured'`), never from a second list
// of ids that could drift away from it.
import type { SkillSource } from './settings'

export type SkillActivationPolicy = 'always-on' | 'user-controlled'

export const skillActivationPolicy = (source: SkillSource): SkillActivationPolicy =>
  source === 'featured' ? 'always-on' : 'user-controlled'

export const isSkillAlwaysOn = (source: SkillSource): boolean =>
  skillActivationPolicy(source) === 'always-on'

/** Stable code a caller can act on; the renderer turns it into the reader's language. */
export const SKILL_ALWAYS_ON_REASON = 'skill-always-on'

export class SkillAlwaysOnRefusal extends Error {
  readonly reason = SKILL_ALWAYS_ON_REASON

  constructor(readonly skillId: string) {
    super(`${SKILL_ALWAYS_ON_REASON}:${skillId}`)
  }
}
