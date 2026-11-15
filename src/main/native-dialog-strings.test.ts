import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

// The tables are pure data; the locale cascade is not exercised here (each dialog's own suite drives
// that through `app.getLocale`). The mock only keeps `native-locale` importable without Electron.
vi.mock('electron', () => ({ app: { getLocale: (): string => 'en' } }))

import {
  FILE_DIALOG_STRINGS,
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

// The file-panel table is larger and carries one field that is a function of the count, so its
// discipline is checked separately: the sweep above compares plain strings row by row.
describe('native file panel string table', () => {
  const stringFields = (code: (typeof NATIVE_LOCALE_CODES)[number]): Array<[string, string]> =>
    Object.entries(FILE_DIALOG_STRINGS[code]).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string'
    )

  it('carries all nine languages', () => {
    expect(Object.keys(FILE_DIALOG_STRINGS).sort()).toEqual([...NATIVE_LOCALE_CODES].sort())
  })

  it('fills every sentence in every language', () => {
    for (const code of NATIVE_LOCALE_CODES) {
      const fields = stringFields(code)
      // The table has twenty fields, one of which is the count function; fifteen is far below the
      // real number and only guards against a sweep that stopped early.
      expect(fields.length).toBeGreaterThan(15)
      for (const [field, value] of fields) {
        expect(`${code}.${field}=${value}`).not.toMatch(/=\s*$/)
      }
      expect(FILE_DIALOG_STRINGS[code].overwriteNotebooksMessage(2).trim().length).toBeGreaterThan(
        0
      )
      expect(FILE_DIALOG_STRINGS[code].overwriteNotebooksMessage(1).trim().length).toBeGreaterThan(
        0
      )
    }
  })

  it('never repeats an English sentence in another language', () => {
    const english = Object.fromEntries(stringFields('en'))
    for (const code of NATIVE_LOCALE_CODES) {
      if (code === 'en') continue
      for (const [field, value] of stringFields(code)) {
        expect(`${code}.${field}: ${value}`).not.toBe(`${code}.${field}: ${english[field]}`)
      }
      // The count sentence gets the same treatment: a row copied from English shows the English
      // sentence shape, which differs in every one of the other eight languages.
      expect(
        `${code}.overwrite: ${FILE_DIALOG_STRINGS[code].overwriteNotebooksMessage(3)}`
      ).not.toBe(`${code}.overwrite: ${FILE_DIALOG_STRINGS.en.overwriteNotebooksMessage(3)}`)
    }
  })

  it('keeps the Traditional row Traditional', () => {
    const traditional = stringFields('zh-Hant')
    const simplified = Object.fromEntries(stringFields('zh'))
    expect(JSON.stringify(traditional)).not.toBe(JSON.stringify(Object.entries(simplified)))
    for (const [field, value] of traditional) {
      for (const character of SIMPLIFIED_ONLY) {
        expect(
          value.includes(character) ? `zh-Hant.${field} still carries ${character}` : 'ok'
        ).toBe('ok')
      }
    }
  })

  it('does not fill several panels with the same sentence', () => {
    // A row filled by copying one title across the whole table would satisfy every other check here
    // (non-blank, not English) while making four different panels indistinguishable.
    for (const code of NATIVE_LOCALE_CODES) {
      const row = FILE_DIALOG_STRINGS[code]
      const titles = [
        row.importConnectorTitle,
        row.exportConnectorTitle,
        row.importSessionPackageTitle,
        row.exportSessionPackageTitle,
        row.exportSupportBundleTitle,
        row.saveUpdateInstallerTitle,
        row.saveFileTitle,
        row.saveArtifactTitle,
        row.chooseArtifactFolderTitle,
        row.saveAnnotationNotesTitle,
        row.saveAnnotatedCopyTitle,
        row.exportNotebooksTitle,
        row.overwriteNotebooksTitle
      ]
      expect(`${code}: ${new Set(titles).size} of ${titles.length}`).toBe(
        `${code}: ${titles.length} of ${titles.length}`
      )
      expect(`${code}: ${row.overwriteButton}`).not.toBe(`${code}: ${row.cancelButton}`)
    }
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
