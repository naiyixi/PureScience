// A4: pins the conclusion behind the availability matrix's row list with a machine-checkable fact
// instead of a comment. The question the K2 slice left open was "should codebuddy get a row?" — the
// answer is no, and the reason is a property of the framework itself (supportsSkills), not a preference.

import { describe, expect, it } from 'vitest'

import {
  claudeCodeFramework,
  codeBuddyFramework,
  codexFramework,
  opencodeFramework
} from '../agent-framework'
import {
  SKILL_AVAILABILITY_TARGET_IDS,
  isSkillAvailabilityTargetId
} from '../../shared/skill-availability'

describe('skill availability targets', () => {
  const frameworks = [claudeCodeFramework, codeBuddyFramework, codexFramework, opencodeFramework]

  it('gives a row exactly to the frameworks that can withhold a skill', () => {
    // The invariant, not the literal: a reader gets a row when the framework can provision a skill
    // surface at all. Adding a framework that gains a skill surface makes this test demand its row, and
    // one that loses the surface makes it demand the row go away — so the list cannot silently drift.
    const canWithhold = frameworks
      .filter((framework) => framework.supportsSkills)
      .map((framework) => framework.id)
      .sort()

    expect([...SKILL_AVAILABILITY_TARGET_IDS].sort()).toEqual(canWithhold)
  })

  it('leaves codebuddy out on purpose, not by omission', () => {
    // It is a real, selectable framework — so its absence is a decision — and it reports no config-dir
    // materialized skill surface the app could provision (src/main/agent-framework/codebuddy.ts). A row
    // for it would be a switch that changes nothing any session loads.
    expect(frameworks.map((framework) => framework.id)).toContain('codebuddy')
    expect(codeBuddyFramework.supportsSkills).toBe(false)
    expect(SKILL_AVAILABILITY_TARGET_IDS).not.toContain('codebuddy')
  })

  it('rejects an id that cannot withhold a skill', () => {
    expect(isSkillAvailabilityTargetId('opencode')).toBe(true)
    expect(isSkillAvailabilityTargetId('codebuddy')).toBe(false)
    expect(isSkillAvailabilityTargetId('made-up')).toBe(false)
    expect(isSkillAvailabilityTargetId('')).toBe(false)
  })
})
