// The gallery is only worth having if its cards cannot drift away from what was measured. This test is
// the drift guard, and it is deliberately blunt: every value and every quote a card shows must appear
// **verbatim** in one of the evidence files the card names, and every path a card tells the reader to run
// must still exist. A paraphrase, a rounded number or a renamed spec file fails here rather than reaching
// a reader as a claim nobody checked.
//
// It also holds the copy contract: three dictionary keys per sample, present in all nine languages. A new
// card without translations is a type error in the data module and a failure here, so the panel can never
// open onto raw key names.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { de } from '@/i18n/de'
import { en } from '@/i18n/en'
import { es } from '@/i18n/es'
import { fr } from '@/i18n/fr'
import { ja } from '@/i18n/ja'
import { ko } from '@/i18n/ko'
import { ru } from '@/i18n/ru'
import { zh } from '@/i18n/zh'
import { zhHant } from '@/i18n/zh-Hant'

import { USE_CASE_SAMPLES, USE_CASE_SAMPLE_IDS, sampleKey } from './use-case-gallery'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..', '..', '..')

const dictionaries = { en, zh, 'zh-Hant': zhHant, de, es, fr, ja, ko, ru } as const

// Paths a reader is told to run: the spec or test file the command names. Anything else in a command is
// an argument, not a file this repo should be able to resolve.
const pathInCommand = (command: string): string[] =>
  command.split(/\s+/).filter((token) => /^(e2e|src|packages|scripts)\//.test(token))

describe('use-case gallery content', () => {
  it('keeps every measured value and quote verbatim in an evidence file it names', () => {
    for (const sample of USE_CASE_SAMPLES) {
      const texts = sample.evidence.map((file) => readFileSync(join(repoRoot, file), 'utf8'))
      expect(texts.length, `${sample.id} names no evidence file`).toBeGreaterThan(0)

      for (const reading of sample.readings) {
        expect(
          texts.some((text) => text.includes(reading.value)),
          `${sample.id}: reading "${reading.value}" is not in ${sample.evidence.join(', ')}`
        ).toBe(true)
      }
      for (const quote of sample.quotes) {
        expect(
          texts.some((text) => text.includes(quote.text)),
          `${sample.id}: quote "${quote.text}" is not in ${sample.evidence.join(', ')}`
        ).toBe(true)
      }
    }
  })

  it('points every card at evidence and at a command file that exist on disk', () => {
    for (const sample of USE_CASE_SAMPLES) {
      for (const file of sample.evidence) {
        expect(existsSync(join(repoRoot, file)), `${sample.id}: missing ${file}`).toBe(true)
      }
      const paths = pathInCommand(sample.command)
      expect(paths.length, `${sample.id}: command names no file to rerun`).toBeGreaterThan(0)
      for (const path of paths) {
        expect(existsSync(join(repoRoot, path)), `${sample.id}: missing ${path}`).toBe(true)
      }
    }
  })

  it('gives every card at least two readings and one quote', () => {
    for (const sample of USE_CASE_SAMPLES) {
      expect(sample.readings.length, `${sample.id} readings`).toBeGreaterThanOrEqual(2)
      expect(sample.quotes.length, `${sample.id} quotes`).toBeGreaterThanOrEqual(1)
      for (const reading of sample.readings) {
        expect(reading.label.trim(), `${sample.id}: empty reading label`).not.toBe('')
        expect(reading.value.trim(), `${sample.id}: empty reading value`).not.toBe('')
      }
    }
    expect(new Set(USE_CASE_SAMPLE_IDS).size).toBe(USE_CASE_SAMPLES.length)
  })

  it('translates every card into all nine languages', () => {
    for (const sample of USE_CASE_SAMPLES) {
      for (const field of ['title', 'claim', 'judgment'] as const) {
        const key = sampleKey(sample.id, field)
        for (const [language, dictionary] of Object.entries(dictionaries)) {
          const value = (dictionary as Record<string, string>)[key]
          expect(value, `${language} is missing ${key}`).toBeTypeOf('string')
          expect(String(value).trim(), `${language} has an empty ${key}`).not.toBe('')
        }
        // The Chinese dictionaries must not fall back to the English sentence: that is the shape a new
        // key takes when it is added to en and copied across without translating.
        expect(zh[key], `zh equals en for ${key}`).not.toBe(en[key])
        expect(zhHant[key], `zh-Hant equals en for ${key}`).not.toBe(en[key])
      }
    }
  })
})
