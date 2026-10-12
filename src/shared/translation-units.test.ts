import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
  TRANSLATION_RECORD_SCHEMA_VERSION,
  TRANSLATION_SOURCE_HASH_RECIPE,
  TRANSLATION_UNIT_MAX_CHARS,
  normalizeTranslationSource,
  pagesWithoutTranslationUnits,
  planTranslation,
  segmentPageIntoTranslationUnits,
  translationSourceHashInput,
  type TranslationRecord,
  type TranslationUnit
} from './translation-units'

// A third party's implementation of the published recipe, written from the description in the module header
// rather than by calling the module's own helper: the point of publishing a recipe is that someone holding the
// bytes can reproduce the digest without our code. If this drifts from the module, the recipe is not published.
const thirdPartyHash = (unitId: string, text: string): string =>
  createHash('sha256')
    .update(
      `purescience-translation-source-v1\n${unitId}\n${text.replace(/\s+/g, ' ').trim()}\n`,
      'utf8'
    )
    .digest('hex')

const hashOf = (unit: TranslationUnit): string => thirdPartyHash(unit.id, unit.text)

const translated = (unit: TranslationUnit, text: string, updatedAt = 1): TranslationRecord => ({
  id: unit.id,
  page: unit.page,
  sourceHash: hashOf(unit),
  status: 'translated',
  text,
  updatedAt
})

describe('translation units', () => {
  it('keeps the published recipe constant in the schema version family', () => {
    expect(TRANSLATION_RECORD_SCHEMA_VERSION).toBe(1)
    expect(TRANSLATION_SOURCE_HASH_RECIPE).toBe('purescience-translation-source-v1')
  })

  it('splits a page into one unit per paragraph and numbers them from 1', () => {
    const units = segmentPageIntoTranslationUnits(7, 'First para.\n\nSecond para.\n\n\nThird para.')
    expect(units.map((unit) => unit.id)).toEqual(['p7#1', 'p7#2', 'p7#3'])
    expect(units.map((unit) => unit.text)).toEqual(['First para.', 'Second para.', 'Third para.'])
    expect(units.every((unit) => unit.page === 7)).toEqual(true)
    expect(units.map((unit) => unit.paragraph)).toEqual([1, 2, 3])
    expect(units.every((unit) => unit.part === undefined)).toEqual(true)
  })

  it('normalizes line wrapping away, so a re-extracted page is not mistaken for an edit', () => {
    const wrapped = segmentPageIntoTranslationUnits(
      3,
      'A single sentence\nthat a PDF wrapped\nacross lines.'
    )
    const oneLine = segmentPageIntoTranslationUnits(
      3,
      'A   single sentence  that a PDF wrapped across lines.'
    )
    expect(wrapped[0]?.text).toEqual('A single sentence that a PDF wrapped across lines.')
    expect(wrapped[0]?.text).toEqual(oneLine[0]?.text)
  })

  it('splits an over-long paragraph into numbered parts instead of sending one unbounded unit', () => {
    const long = `${'word '.repeat(400)}end`
    const units = segmentPageIntoTranslationUnits(2, long, { maxChars: 100 })
    expect(units.length).toBeGreaterThan(1)
    expect(units.map((unit) => unit.id)).toEqual(units.map((_, index) => `p2#1.${index + 1}`))
    expect(units.every((unit) => unit.text.length <= 100)).toEqual(true)
    // Nothing is dropped by the split: the parts rejoin into the same sentence.
    expect(units.map((unit) => unit.text).join(' ')).toEqual(normalizeTranslationSource(long))
    expect(units.every((unit) => unit.paragraph === 1)).toEqual(true)
  })

  it('never lets a word be cut in half when a boundary exists', () => {
    const units = segmentPageIntoTranslationUnits(1, `${'alpha bravo '.repeat(30)}omega`, {
      maxChars: 40
    })
    for (const unit of units) expect(unit.text).not.toMatch(/alph$|brav$|omeg$/)
  })

  it('reports a page with no text layer as zero units, not as an empty translation', () => {
    expect(segmentPageIntoTranslationUnits(5, '')).toEqual([])
    expect(segmentPageIntoTranslationUnits(5, '   \n\n \n ')).toEqual([])
    expect(pagesWithoutTranslationUnits(6, segmentPageIntoTranslationUnits(2, 'text'))).toEqual([
      1, 3, 4, 5, 6
    ])
  })

  it('rejects a nonsensical split budget rather than silently producing empty units', () => {
    expect(() => segmentPageIntoTranslationUnits(1, 'text', { maxChars: 0 })).toThrow()
  })

  it('round-trips the published hash input through an independently written recipe', () => {
    const unit: TranslationUnit = {
      id: 'p12#4',
      page: 12,
      paragraph: 4,
      text: '  A  sentence\nthat wrapped. '
    }
    expect(translationSourceHashInput(unit.id, unit.text)).toEqual(
      'purescience-translation-source-v1\np12#4\nA sentence that wrapped.\n'
    )
    expect(thirdPartyHash(unit.id, unit.text)).toEqual(
      createHash('sha256')
        .update('purescience-translation-source-v1\np12#4\nA sentence that wrapped.\n', 'utf8')
        .digest('hex')
    )
  })

  it('is sensitive to the unit id as well as the text', () => {
    expect(thirdPartyHash('p1#1', 'same text')).not.toEqual(thirdPartyHash('p1#2', 'same text'))
  })
})

describe('translation resume plan', () => {
  const units = segmentPageIntoTranslationUnits(1, 'Alpha.\n\nBeta.\n\nGamma.')

  it('sends only the units with no usable record', () => {
    const plan = planTranslation(units, { 'p1#1': translated(units[0]!, '甲。') }, hashOf)
    expect(plan.reused).toEqual(['p1#1'])
    expect(plan.toTranslate.map((entry) => entry.unit.id)).toEqual(['p1#2', 'p1#3'])
    expect(plan.toTranslate.every((entry) => entry.reason === 'missing')).toEqual(true)
  })

  it('re-translates a paragraph whose source changed instead of reporting it as done', () => {
    const stored = translated(units[1]!, '乙。')
    const edited = segmentPageIntoTranslationUnits(1, 'Alpha.\n\nBeta revised.\n\nGamma.')
    const plan = planTranslation(edited, { 'p1#2': stored }, hashOf)
    expect(plan.reused).toEqual([])
    expect(plan.toTranslate.map((entry) => [entry.unit.id, entry.reason])).toEqual([
      ['p1#1', 'missing'],
      ['p1#2', 'hash-changed'],
      ['p1#3', 'missing']
    ])
  })

  it('does not treat a previously failed unit as translated, and names the reason', () => {
    const failed: TranslationRecord = {
      id: 'p1#2',
      page: 1,
      sourceHash: hashOf(units[1]!),
      status: 'failed',
      reason: 'timeout',
      updatedAt: 5
    }
    const plan = planTranslation(units, { 'p1#2': failed }, hashOf)
    const entry = plan.toTranslate.find((candidate) => candidate.unit.id === 'p1#2')
    expect(entry?.reason).toEqual('previous-attempt-failed')
    expect(plan.reused).toEqual([])
  })

  it('treats a record with no text as not translated, whatever its status says', () => {
    const hollow = { ...translated(units[0]!, '甲。'), text: '' }
    const plan = planTranslation(units, { 'p1#1': hollow }, hashOf)
    expect(plan.reused).toEqual([])
    expect(plan.toTranslate[0]?.reason).toEqual('previous-attempt-failed')
  })

  it('drops records whose paragraph is gone from the source, and says which', () => {
    const stored = { 'p1#1': translated(units[0]!, '甲。'), 'p1#9': translated(units[0]!, '旧。') }
    const plan = planTranslation(units, stored, hashOf)
    expect(plan.removed).toEqual(['p1#9'])
    expect(plan.reused).toEqual(['p1#1'])
  })

  it('never reuses a record whose hash was not recorded', () => {
    const noHash = { ...translated(units[0]!, '甲。'), sourceHash: '' }
    const plan = planTranslation(units, { 'p1#1': noHash }, hashOf)
    expect(plan.reused).toEqual([])
    expect(plan.toTranslate[0]?.reason).toEqual('hash-changed')
  })

  it('leaves the max unit budget published for the split threshold', () => {
    expect(TRANSLATION_UNIT_MAX_CHARS).toBe(1200)
  })
})
