import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

// The tables are pure data; the locale cascade is not exercised here (each dialog's own suite drives
// that through `app.getLocale`). The mock only keeps `native-locale` importable without Electron.
vi.mock('electron', () => ({ app: { getLocale: (): string => 'en' } }))

import {
  MIGRATION_QUIT_STRINGS,
  RENDERER_RECOVERY_STRINGS,
  type MigrationQuitStrings,
  type RendererRecoveryStrings
} from './native-dialog-strings'
import { NATIVE_LOCALE_CODES } from './native-locale'

// The English wording these two dialogs shipped with before the tables existed. A native dialog has
// no rendered output to diff, so this pin is the only thing that keeps the wording from drifting
// while the other eight languages are added around it.
const PREVIOUS_EN_MIGRATION_QUIT = {
  keepWaiting: 'Keep waiting',
  quitAnyway: 'Quit anyway',
  title: 'Move in progress',
  message: 'PureScience is still moving your data.',
  detail:
    'Your data is safe either way, but quitting now leaves the move unfinished — you may need to start it again. Keep the app open until it finishes.'
}

const PREVIOUS_EN_RENDERER_RECOVERY = {
  reload: 'Reload',
  closeWindow: 'Close window',
  message: 'The app window stopped responding repeatedly.',
  detail:
    'Automatic recovery has been paused. Reloading returns this window to the home screen; background work may still be running.'
}

// Characters that only exist in the simplified set: a Traditional row that still carries one of these
// was copied from the Simplified row instead of written. Small on purpose — it is a fallback detector,
// not a proofreader.
const SIMPLIFIED_ONLY = [
  '实',
  '数',
  '据',
  '动',
  '开',
  '关',
  '复',
  '载',
  '应',
  '让',
  '会',
  '时',
  '间',
  '这'
]

const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')

describe('native dialog string tables', () => {
  it('carries exactly the nine interface languages in both tables', () => {
    expect(Object.keys(MIGRATION_QUIT_STRINGS).sort()).toEqual([...NATIVE_LOCALE_CODES].sort())
    expect(Object.keys(RENDERER_RECOVERY_STRINGS).sort()).toEqual([...NATIVE_LOCALE_CODES].sort())
  })

  it('fills every field of every language with non-blank text', () => {
    for (const code of NATIVE_LOCALE_CODES) {
      for (const [field, value] of Object.entries(MIGRATION_QUIT_STRINGS[code])) {
        expect(`${code}.${field}=${value}`).not.toMatch(/=\s*$/)
      }
      for (const [field, value] of Object.entries(RENDERER_RECOVERY_STRINGS[code])) {
        expect(`${code}.${field}=${value}`).not.toMatch(/=\s*$/)
      }
    }
  })

  // The whole point of the tables: a reader of another language must not be handed the English
  // sentence. A row copied verbatim from English is exactly the failure this catches.
  it('never repeats the English value in another language', () => {
    const fieldsOf = <T extends Record<string, string>>(table: T): string[] => Object.keys(table)
    for (const code of NATIVE_LOCALE_CODES) {
      if (code === 'en') continue
      for (const field of fieldsOf(MIGRATION_QUIT_STRINGS.en)) {
        const translated = MIGRATION_QUIT_STRINGS[code][field as keyof MigrationQuitStrings]
        expect(`${code}.${field}: ${translated}`).not.toBe(
          `${code}.${field}: ${MIGRATION_QUIT_STRINGS.en[field as keyof MigrationQuitStrings]}`
        )
      }
      for (const field of fieldsOf(RENDERER_RECOVERY_STRINGS.en)) {
        const translated = RENDERER_RECOVERY_STRINGS[code][field as keyof RendererRecoveryStrings]
        expect(`${code}.${field}: ${translated}`).not.toBe(
          `${code}.${field}: ${RENDERER_RECOVERY_STRINGS.en[field as keyof RendererRecoveryStrings]}`
        )
      }
    }
  })

  it('keeps the Traditional row Traditional and not a copy of the Simplified one', () => {
    const pairs: Array<[Record<string, string>, Record<string, string>, string]> = [
      [MIGRATION_QUIT_STRINGS.zh, MIGRATION_QUIT_STRINGS['zh-Hant'], 'migration'],
      [RENDERER_RECOVERY_STRINGS.zh, RENDERER_RECOVERY_STRINGS['zh-Hant'], 'recovery']
    ]
    for (const [simplified, traditional, name] of pairs) {
      // Whole-row, not field-by-field: a few words (退出/取消) are the same character in both
      // scripts, so requiring every field to differ would fail on correct Traditional text.
      expect(`${name}: ${JSON.stringify(traditional)}`).not.toBe(
        `${name}: ${JSON.stringify(simplified)}`
      )
      for (const field of Object.keys(traditional)) {
        const value = traditional[field]
        for (const character of SIMPLIFIED_ONLY) {
          expect(
            value.includes(character)
              ? `${name}.${field} still carries ${character}: ${value}`
              : 'ok'
          ).toBe('ok')
        }
      }
    }
  })

  it('keeps the English wording byte-identical to what those dialogs already shipped', () => {
    expect(MIGRATION_QUIT_STRINGS.en).toEqual(PREVIOUS_EN_MIGRATION_QUIT)
    expect(RENDERER_RECOVERY_STRINGS.en).toEqual(PREVIOUS_EN_RENDERER_RECOVERY)
  })
})

// The tables only help if the dialogs actually read them. A native dialog has no window to inspect,
// so this reads the two call sites: the English sentences must be gone from them (comments stripped —
// naming the sentence it replaced is documentation, not a second copy), and the localising helper must
// be the thing filling the options.
describe('the dialogs draw their wording from the tables, not from literals', () => {
  const callSites: Array<[string, Record<string, string>]> = [
    ['storage/migration-state.ts', PREVIOUS_EN_MIGRATION_QUIT],
    ['windows.ts', PREVIOUS_EN_RENDERER_RECOVERY]
  ]

  for (const [relativePath, english] of callSites) {
    it(`${relativePath} carries no English dialog literals`, () => {
      const source = stripComments(readFileSync(join(__dirname, relativePath), 'utf8'))
      expect(source.length).toBeGreaterThan(200)
      expect(source).toContain('nativeStringsFor(')
      for (const sentence of Object.values(english)) {
        expect(source).not.toContain(sentence)
      }
    })
  }
})
