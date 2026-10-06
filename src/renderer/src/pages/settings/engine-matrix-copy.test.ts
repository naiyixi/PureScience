// The engine matrix's copy contract: the shared catalog hands over copy *keys* (labelKey /
// summaryKey) instead of literals, so the window can translate them — which only works if every key
// really exists in every dictionary. Importing the dictionaries and reading the same constants the
// component reads is what makes a typo (or a key added to only one language) fail here instead of
// reaching the screen as a raw `engines.…` string.
import { describe, expect, it } from 'vitest'

import { ENGINE_CATALOG } from '../../../../shared/engine-catalog'
import { de } from '../../i18n/de'
import { en } from '../../i18n/en'
import { es } from '../../i18n/es'
import { fr } from '../../i18n/fr'
import { ja } from '../../i18n/ja'
import { ko } from '../../i18n/ko'
import { ru } from '../../i18n/ru'
import { zh } from '../../i18n/zh'
import { zhHant } from '../../i18n/zh-Hant'
import { BLOCKED_BY_WEIGHTS_KEY, OUTPUT_KEYS, STATUS_KEYS, WEIGHT_KEYS } from './engine-matrix-copy'

const DICTIONARIES: Record<string, Record<string, string>> = {
  en,
  zh,
  'zh-Hant': zhHant,
  ja,
  ko,
  fr,
  de,
  es,
  ru
}

const ENGINE_IDS = [
  'alphafold-db',
  'pdb',
  'esmfold',
  'colabfold',
  'ddg-cpu-predictor',
  'openmm-fep',
  'rosetta-ddg'
]

describe('engine matrix copy', () => {
  it('covers the seven catalog engines with a key for the name and one for the summary', () => {
    expect(ENGINE_CATALOG.map((engine) => engine.id)).toEqual(ENGINE_IDS)
  })

  it('resolves every key the matrix renders in all nine dictionaries', () => {
    const keys = [
      ...ENGINE_CATALOG.flatMap((engine) => [engine.labelKey, engine.summaryKey]),
      ...Object.values(STATUS_KEYS),
      BLOCKED_BY_WEIGHTS_KEY,
      ...Object.values(WEIGHT_KEYS),
      ...Object.values(OUTPUT_KEYS),
      'engines.licenseRestricted',
      'settings.enginesTitle',
      'settings.enginesIntro',
      'settings.enginesGpuRule'
    ]
    // Guard against a silently empty sweep: seven engines plus chrome is far more than twenty keys.
    expect(keys.length).toBeGreaterThan(25)

    const missing: string[] = []
    for (const [language, dictionary] of Object.entries(DICTIONARIES)) {
      for (const key of keys) {
        const value = dictionary[key]
        if (typeof value !== 'string' || value.trim() === '') missing.push(`${language}:${key}`)
      }
    }
    expect(missing).toEqual([])
  })

  it('declares no engines.* key the matrix cannot resolve', () => {
    const declared = new Set([
      ...ENGINE_CATALOG.flatMap((engine) => [engine.labelKey, engine.summaryKey]),
      ...Object.values(STATUS_KEYS),
      BLOCKED_BY_WEIGHTS_KEY,
      ...Object.values(WEIGHT_KEYS),
      ...Object.values(OUTPUT_KEYS),
      'engines.licenseRestricted'
    ])
    const inDictionary = Object.keys(en).filter((key) => key.startsWith('engines.'))
    expect(inDictionary.filter((key) => !declared.has(key))).toEqual([])
  })
})
