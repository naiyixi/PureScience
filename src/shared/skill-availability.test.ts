import { describe, expect, it } from 'vitest'

import { sanitizeSkillAvailability, skillIdsDisabledForTarget } from './skill-availability'

// Two promises this feature makes, and the cases that hold it to them: a per-target set can never be a way
// around the always-on gate, and anything this build cannot interpret is dropped rather than carried.

const alwaysOn = new Set(['os-gatekeeper'])

describe('skillIdsDisabledForTarget', () => {
  it('unions the global set with the target-specific one', () => {
    expect(
      [
        ...skillIdsDisabledForTarget({
          availability: { codex: { disabledSkillIds: ['pdf-notes'] } },
          targetId: 'codex',
          globalDisabledIds: ['figures'],
          alwaysOnSkillIds: alwaysOn
        })
      ].sort()
    ).toEqual(['figures', 'pdf-notes'])
  })

  it('never withholds an always-on skill, even when a target asks for it', () => {
    const disabled = skillIdsDisabledForTarget({
      availability: { codex: { disabledSkillIds: ['os-gatekeeper'] } },
      targetId: 'codex',
      globalDisabledIds: ['os-gatekeeper'],
      alwaysOnSkillIds: alwaysOn
    })

    // Otherwise the per-target set would be a documented way around the gate.
    expect(disabled.size).toBe(0)
  })

  it('leaves another target untouched', () => {
    const disabled = skillIdsDisabledForTarget({
      availability: { codex: { disabledSkillIds: ['pdf-notes'] } },
      targetId: 'claude-code',
      globalDisabledIds: [],
      alwaysOnSkillIds: alwaysOn
    })

    expect(disabled.size).toBe(0)
  })
})

describe('sanitizeSkillAvailability', () => {
  it('keeps known-shaped targets and drops empty ones', () => {
    expect(
      sanitizeSkillAvailability({
        codex: { disabledSkillIds: ['a', 'a', '', 'b'] },
        'claude-code': { disabledSkillIds: [] },
        broken: 'nope',
        '': { disabledSkillIds: ['a'] }
      })
    ).toEqual({ codex: { disabledSkillIds: ['a', 'b'] } })
  })

  it('reads a map with nothing usable as nothing configured', () => {
    expect(sanitizeSkillAvailability({})).toBeUndefined()
    expect(sanitizeSkillAvailability([])).toBeUndefined()
    expect(sanitizeSkillAvailability('nope')).toBeUndefined()
  })
})
