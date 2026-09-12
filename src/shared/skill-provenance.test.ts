// Provenance + verification gate for learnt skills: only verified knowledge is reusable without
// review, and the state must survive a frontmatter round-trip.

import { describe, expect, it } from 'vitest'

import {
  DEFAULT_SKILL_PROVENANCE,
  describeSkillTrust,
  isProvisionableSkill,
  isReusableWithoutReview,
  parseSkillProvenance,
  skillProvenanceFields,
  SKILL_TRUST_KEY,
  SKILL_TRUST_KIND_KEY,
  SKILL_TRUST_EVIDENCE_KEY,
  SKILL_TRUST_SOURCE_KEY,
  SKILL_TRUST_ORIGIN_KEY,
  type SkillProvenance
} from './skill-provenance'

describe('skill provenance', () => {
  it('treats a freshly drafted skill as unverified and not reusable without review', () => {
    // The whole point: an agent-drafted procedure must not become reusable before something checked
    // it. Fail closed on the default.
    expect(DEFAULT_SKILL_PROVENANCE.verification).toBe('unverified')
    expect(isReusableWithoutReview(DEFAULT_SKILL_PROVENANCE)).toBe(false)
    expect(isReusableWithoutReview({ ...DEFAULT_SKILL_PROVENANCE, verification: 'verified' })).toBe(
      true
    )
    expect(isReusableWithoutReview({ ...DEFAULT_SKILL_PROVENANCE, verification: 'rejected' })).toBe(
      false
    )
  })

  it('fails closed when frontmatter is missing or carries an unknown trust value', () => {
    expect(parseSkillProvenance({}).verification).toBe('unverified')
    expect(parseSkillProvenance({ [SKILL_TRUST_KEY]: 'probably-fine' }).verification).toBe(
      'unverified'
    )
    expect(parseSkillProvenance({ [SKILL_TRUST_KEY]: 'VERIFIED' }).verification).toBe('verified')
    expect(parseSkillProvenance({ [SKILL_TRUST_KIND_KEY]: 'failure-mode' }).kind).toBe(
      'failure-mode'
    )
    expect(parseSkillProvenance({ [SKILL_TRUST_KIND_KEY]: 'something-else' }).kind).toBe(
      'procedure'
    )
  })

  it('round-trips provenance through flat frontmatter fields', () => {
    const provenance: SkillProvenance = {
      kind: 'failure-mode',
      verification: 'verified',
      verifiedBy: 'sci-bench',
      originRunId: 'run-17',
      originTurnId: 'turn-3',
      evidence: ['pip install vina -> needs Boost', 'use conda-forge package instead']
    }

    const fields = skillProvenanceFields(provenance)

    expect(fields[SKILL_TRUST_KEY]).toBe('verified')
    expect(fields[SKILL_TRUST_KIND_KEY]).toBe('failure-mode')
    expect(fields[SKILL_TRUST_SOURCE_KEY]).toBe('sci-bench')
    expect(fields[SKILL_TRUST_ORIGIN_KEY]).toBe('run-17/turn-3')
    expect(parseSkillProvenance(fields)).toEqual(provenance)
  })

  it('only writes the fields that carry information', () => {
    const fields = skillProvenanceFields(DEFAULT_SKILL_PROVENANCE)

    expect(fields).toEqual({ [SKILL_TRUST_KEY]: 'unverified', [SKILL_TRUST_KIND_KEY]: 'procedure' })
    expect(fields[SKILL_TRUST_EVIDENCE_KEY]).toBeUndefined()
    expect(fields[SKILL_TRUST_SOURCE_KEY]).toBeUndefined()
    expect(fields[SKILL_TRUST_ORIGIN_KEY]).toBeUndefined()
  })

  it('drops an unknown verifier and keeps the evidence list parseable', () => {
    const parsed = parseSkillProvenance({
      [SKILL_TRUST_EVIDENCE_KEY]: 'first; second\nthird',
      [SKILL_TRUST_SOURCE_KEY]: 'somebody-else'
    })

    expect(parsed.verifiedBy).toBeUndefined()
    expect(parsed.evidence).toEqual(['first', 'second', 'third'])
  })

  it('fails closed for a learnt entry that nothing verified', () => {
    // Curated skills carry no provenance at all; they are never gated.
    expect(isProvisionableSkill(undefined, 'demo', [])).toBe(true)
    expect(
      isProvisionableSkill({ kind: 'procedure', verification: 'verified', evidence: [] }, 'a', [])
    ).toBe(true)
    // Recorded during a run, never checked -> withheld until the user allows that exact id.
    expect(
      isProvisionableSkill({ kind: 'procedure', verification: 'unverified', evidence: [] }, 'b', [])
    ).toBe(false)
    expect(
      isProvisionableSkill({ kind: 'procedure', verification: 'unverified', evidence: [] }, 'b', [
        'b'
      ])
    ).toBe(true)
    // An explicit allow for one id must not leak to another.
    expect(
      isProvisionableSkill({ kind: 'procedure', verification: 'unverified', evidence: [] }, 'c', [
        'b'
      ])
    ).toBe(false)
    // A rejected entry stays out: it failed its check, so it is not knowledge to reuse.
    expect(
      isProvisionableSkill(
        { kind: 'failure-mode', verification: 'rejected', evidence: [] },
        'd',
        []
      )
    ).toBe(false)
  })

  it('says plainly what the trust state means', () => {
    expect(
      describeSkillTrust({
        ...DEFAULT_SKILL_PROVENANCE,
        verification: 'verified',
        verifiedBy: 'user'
      })
    ).toContain('safe to reuse')
    expect(describeSkillTrust(DEFAULT_SKILL_PROVENANCE)).toContain('do not reuse without review')
    expect(
      describeSkillTrust({ kind: 'failure-mode', verification: 'unverified', evidence: [] })
    ).toContain('read the evidence')
    expect(describeSkillTrust({ ...DEFAULT_SKILL_PROVENANCE, verification: 'rejected' })).toContain(
      'must not be reused'
    )
  })
})
