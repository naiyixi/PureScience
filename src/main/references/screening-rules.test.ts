import { describe, expect, it } from 'vitest'

import type { ScreeningCriterion } from '../../shared/references-screening'
import {
  canonicalCriteria,
  nextRuleRevision,
  parseScreeningCriteria,
  screeningRuleContentHash,
  serializeScreeningCriteria,
  serializeScreeningRule
} from './screening-rules'

// Rule content is what makes a revision verifiable and what lets an append notice that nothing changed.
// The canonical form is therefore a contract, not an implementation detail: if reordering the same
// criteria produced a new hash, a save that only reordered rows would stale every decision in the
// collection — which is exactly what the immutable-revision design is supposed to avoid.

const inclusion: ScreeningCriterion[] = [
  { id: 'i-2', text: '研究对象为成年人' },
  { id: 'i-1', text: '英文或中文全文' }
]
const exclusion: ScreeningCriterion[] = [{ id: 'e-1', text: '综述、社论、病例报告' }]

describe('canonicalCriteria', () => {
  it('orders by criterion id and trims the id', () => {
    expect(canonicalCriteria(inclusion)).toEqual([
      { id: 'i-1', text: '英文或中文全文' },
      { id: 'i-2', text: '研究对象为成年人' }
    ])
    expect(canonicalCriteria([{ id: '  i-1  ', text: 'x' }])).toEqual([{ id: 'i-1', text: 'x' }])
  })

  it('keeps criterion text byte-for-byte, because evidence quotes it back', () => {
    const text = '  研究对象为成年人（含妊娠）  '
    expect(canonicalCriteria([{ id: 'i-1', text }])).toEqual([{ id: 'i-1', text }])
  })

  it('does not mutate the input ordering', () => {
    canonicalCriteria(inclusion)
    expect(inclusion.map((criterion) => criterion.id)).toEqual(['i-2', 'i-1'])
  })
})

describe('screeningRuleContentHash', () => {
  it('is order-insensitive over the same criteria', () => {
    expect(screeningRuleContentHash([...inclusion].reverse(), exclusion)).toBe(
      screeningRuleContentHash(inclusion, exclusion)
    )
  })

  it('changes when a criterion is added, removed, or reworded', () => {
    const base = screeningRuleContentHash(inclusion, exclusion)
    expect(
      screeningRuleContentHash([...inclusion, { id: 'i-3', text: '原始研究' }], exclusion)
    ).not.toBe(base)
    expect(screeningRuleContentHash([inclusion[0]], exclusion)).not.toBe(base)
    expect(
      screeningRuleContentHash([{ id: 'i-2', text: '研究对象为成人' }, inclusion[1]], exclusion)
    ).not.toBe(base)
    expect(screeningRuleContentHash(inclusion, [])).not.toBe(base)
  })

  it('is a stable sha256 over the canonical rule JSON', () => {
    const hash = screeningRuleContentHash(inclusion, exclusion)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    // Pinned so a change to the canonical form cannot pass unnoticed: an existing revision's hash is
    // stored next to the rules it describes, and changing the recipe would silently invalidate it.
    expect(hash).toBe('35f5e0d9eb3be2c1ca3b865a8d31de0dc419ce6151208dd8554c833165788460')
    expect(screeningRuleContentHash(inclusion, exclusion)).toBe(hash)
  })
})

describe('serialization', () => {
  it('serializes criteria as a canonically ordered JSON array', () => {
    expect(serializeScreeningCriteria(inclusion)).toBe(
      '[{"id":"i-1","text":"英文或中文全文"},{"id":"i-2","text":"研究对象为成年人"}]'
    )
    expect(serializeScreeningCriteria([])).toBe('[]')
  })

  it('serializes a whole rule set as the hashed envelope', () => {
    const serialized = serializeScreeningRule(inclusion, exclusion)
    expect(JSON.parse(serialized)).toEqual({
      inclusion: canonicalCriteria(inclusion),
      exclusion: canonicalCriteria(exclusion)
    })
  })
})

describe('parseScreeningCriteria', () => {
  it('round-trips what serialization wrote', () => {
    expect(parseScreeningCriteria(serializeScreeningCriteria(inclusion))).toEqual(
      canonicalCriteria(inclusion)
    )
  })

  it('reads unusable content as an empty rule set instead of a partly-invented one', () => {
    expect(parseScreeningCriteria('not json')).toEqual([])
    expect(parseScreeningCriteria('{"inclusion":[]}')).toEqual([])
    expect(parseScreeningCriteria('null')).toEqual([])
    expect(parseScreeningCriteria('[1, "i-1", {"id":"i-1"}, {"id":"i-1","text":2}]')).toEqual([])
    expect(parseScreeningCriteria('[{"id":"i-1","text":"ok"}, {"id":"i-2"}]')).toEqual([
      { id: 'i-1', text: 'ok' }
    ])
  })
})

describe('nextRuleRevision', () => {
  it('starts at 1 and appends contiguously', () => {
    expect(nextRuleRevision(null)).toBe(1)
    expect(nextRuleRevision(1)).toBe(2)
    expect(nextRuleRevision(7)).toBe(8)
  })
})
