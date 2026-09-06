// Skill description trigger-quality evaluator tests: each check fires on the right input,
// good descriptions score ≥8.

import { describe, expect, it } from 'vitest'

import { evaluateSkillDescription } from './skill-eval-service'

describe('skill description evaluator', () => {
  it('scores a strong description ≥8', () => {
    const result = evaluateSkillDescription(
      'Troubleshoots GitHub Actions CI failures: fetches job logs with the gh CLI, pinpoints the failing step, and proposes a fix.'
    )
    expect(result.score).toBeGreaterThanOrEqual(8)
    expect(result.suggestions).toHaveLength(0)
  })

  it('scores an empty description 0 with a clear message', () => {
    const result = evaluateSkillDescription('')
    expect(result.score).toBe(0)
    expect(result.checks.find((c) => c.id === 'length')?.passed).toBe(false)
  })

  it('flags a weak "a skill for" opener', () => {
    const result = evaluateSkillDescription(
      'A skill for doing some stuff with things in a general way that might be useful.'
    )
    const selfContained = result.checks.find((c) => c.id === 'self_contained')
    expect(selfContained?.passed).toBe(false)
    expect(result.suggestions.some((s) => s.includes('opener'))).toBe(true)
  })

  it('flags missing action vocabulary', () => {
    const result = evaluateSkillDescription(
      'Data about various things and related stuff for the general case.'
    )
    const action = result.checks.find((c) => c.id === 'action_vocabulary')
    expect(action?.passed).toBe(false)
  })

  it('flags filler-only wording without a concrete subject', () => {
    const result = evaluateSkillDescription('A useful skill to help with some helpful stuff.')
    const concrete = result.checks.find((c) => c.id === 'concrete_subject')
    expect(concrete?.passed).toBe(false)
  })

  it('rewards a substantive keyword', () => {
    const result = evaluateSkillDescription(
      'Converts AlphaFold2 contact maps into publication-ready heatmaps with matplotlib.'
    )
    const keyword = result.checks.find((c) => c.id === 'keyword_density')
    expect(keyword?.passed).toBe(true)
  })

  it('returns actionable suggestions for weak descriptions', () => {
    const result = evaluateSkillDescription('stuff')
    expect(result.score).toBeLessThan(5)
    expect(result.suggestions.length).toBeGreaterThan(0)
  })

  it('caps the score at 10 and reports per-check verdicts', () => {
    const result = evaluateSkillDescription(
      'Creates managed local model endpoints: registers idempotent start/stop scripts and probes readiness before dispatch.'
    )
    expect(result.score).toBeLessThanOrEqual(10)
    expect(result.checks.length).toBe(5)
    expect(result.checks.every((c) => typeof c.passed === 'boolean')).toBe(true)
  })
})
