import { describe, expect, it } from 'vitest'

import {
  computeScreeningInputDigest,
  serializeScreeningInputDigest,
  type ScreeningInputDigestInput
} from './screening-digest'

// inputDigest is the key a resume compares, so it must satisfy two properties or the resume is
// unsound: the same input digests identically (else nothing is ever skipped), and any component
// moving changes the digest (else a record whose evidence changed is skipped anyway). Both are
// asserted here, component by component, rather than assumed.

const base = (overrides: Partial<ScreeningInputDigestInput> = {}): ScreeningInputDigestInput => ({
  ruleContentHash: 'rule-hash-a',
  policyKey: 'screening:test-v1',
  coverage: 'full-text',
  sections: {
    metadata: 'Title: A study',
    abstract: 'We enrolled 120 adults.',
    fullText: 'Methods. We enrolled 120 adults aged 18-65.'
  },
  ...overrides
})

describe('computeScreeningInputDigest', () => {
  it('digests the same input identically across two computations', () => {
    expect(computeScreeningInputDigest(base())).toBe(computeScreeningInputDigest(base()))
  })

  it('produces a hex sha256', () => {
    expect(computeScreeningInputDigest(base())).toMatch(/^[0-9a-f]{64}$/)
  })

  it('does not depend on the order the sections object was built in', () => {
    const sections = {
      metadata: 'Title: A study',
      abstract: 'We enrolled 120 adults.',
      fullText: 'Methods. We enrolled 120 adults aged 18-65.'
    }
    const reordered = {
      fullText: sections.fullText,
      metadata: sections.metadata,
      abstract: sections.abstract
    }
    expect(computeScreeningInputDigest(base({ sections: reordered }))).toBe(
      computeScreeningInputDigest(base({ sections }))
    )
  })

  it('changes when the rule content hash changes', () => {
    expect(computeScreeningInputDigest(base({ ruleContentHash: 'rule-hash-b' }))).not.toBe(
      computeScreeningInputDigest(base())
    )
  })

  it('changes when the policy key changes', () => {
    expect(computeScreeningInputDigest(base({ policyKey: 'screening:test-v2' }))).not.toBe(
      computeScreeningInputDigest(base())
    )
  })

  it('changes when the coverage tier changes', () => {
    expect(computeScreeningInputDigest(base({ coverage: 'abstract-only' }))).not.toBe(
      computeScreeningInputDigest(base())
    )
  })

  it.each([
    ['metadata', { ...base().sections, metadata: 'Title: A study (revised)' }],
    ['abstract', { ...base().sections, abstract: 'We enrolled 121 adults.' }],
    ['fullText', { ...base().sections, fullText: `${base().sections.fullText} One more line.` }]
  ])('changes when the %s evidence text changes by one character', (_tier, sections) => {
    expect(computeScreeningInputDigest(base({ sections }))).not.toBe(
      computeScreeningInputDigest(base())
    )
  })

  it('is sensitive to a whitespace-only evidence change, so a re-read is never silently skipped', () => {
    const sections = { ...base().sections, fullText: `${base().sections.fullText} ` }
    expect(computeScreeningInputDigest(base({ sections }))).not.toBe(
      computeScreeningInputDigest(base())
    )
  })
})

describe('serializeScreeningInputDigest', () => {
  it('emits canonical JSON with sorted keys, so the digest reflects values not insertion order', () => {
    const serialized = serializeScreeningInputDigest(base())
    expect(serialized).toBe(
      '{"coverage":"full-text","policyKey":"screening:test-v1","ruleContentHash":"rule-hash-a","sections":{"abstract":"We enrolled 120 adults.","fullText":"Methods. We enrolled 120 adults aged 18-65.","metadata":"Title: A study"}}'
    )
  })
})
