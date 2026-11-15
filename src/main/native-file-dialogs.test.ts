import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

// The locale the OS reports, in the shape `native-locale` reads it. Held in `vi.hoisted` so the
// module factory below can close over it; each test sets it and resets it afterwards.
const osState = vi.hoisted(() => ({ locale: 'en' }))
vi.mock('electron', () => ({ app: { getLocale: (): string => osState.locale } }))

import { FILE_DIALOG_STRINGS, type FileDialogStrings } from './native-dialog-strings'
import { NATIVE_LOCALE_CODES, type NativeLocaleCode } from './native-locale'
import {
  annotationSavePanelOptions,
  connectorConfigOpenPanelOptions,
  connectorConfigSavePanelOptions,
  managedFileSavePanelOptions,
  notebookExportOpenPanelOptions,
  notebookOverwritePanelOptions,
  sessionArtifactFolderPanelOptions,
  sessionArtifactSavePanelOptions,
  sessionPackageOpenPanelOptions,
  sessionPackageSavePanelOptions,
  supportBundleSavePanelOptions,
  updateInstallerSavePanelOptions
} from './native-file-dialogs'

// One row per OS panel the app opens for the user. `surfaced` is what the reader will see on that
// panel; `fields` names the table fields the panel is allowed to read. Both are spelled out rather
// than derived from the builder, so a builder that reads a sibling field — the artifact title on the
// file panel, say — fails here instead of shipping a plausible wrong word.
type PanelCase = {
  name: string
  surfaced: (code: NativeLocaleCode) => string[]
  fields: Array<keyof FileDialogStrings>
  legacyEn: string[]
}

const panels: PanelCase[] = [
  {
    name: 'connector configuration — import',
    surfaced: (code) => {
      const options = connectorConfigOpenPanelOptions(code)
      return [options.title ?? '', options.filters?.[0]?.name ?? '']
    },
    fields: ['importConnectorTitle', 'connectorFilter'],
    legacyEn: ['Import Connector configuration', 'Connector configuration']
  },
  {
    name: 'connector configuration — export',
    surfaced: (code) => {
      const options = connectorConfigSavePanelOptions('/tmp/connector.json', code)
      return [options.title ?? '', options.filters?.[0]?.name ?? '']
    },
    fields: ['exportConnectorTitle', 'connectorFilter'],
    legacyEn: ['Export Connector configuration', 'Connector configuration']
  },
  {
    name: 'session package — import',
    surfaced: (code) => {
      const options = sessionPackageOpenPanelOptions(code)
      return [options.title ?? '', options.filters?.[0]?.name ?? '']
    },
    fields: ['importSessionPackageTitle', 'sessionPackageFilter'],
    legacyEn: ['Import session package', 'PureScience session package']
  },
  {
    name: 'session package — export',
    surfaced: (code) => {
      const options = sessionPackageSavePanelOptions('/tmp/session.science', code)
      return [options.title ?? '', options.filters?.[0]?.name ?? '']
    },
    fields: ['exportSessionPackageTitle', 'sessionPackageFilter'],
    legacyEn: ['Export session package', 'PureScience session package']
  },
  {
    name: 'support bundle — export',
    surfaced: (code) => {
      const options = supportBundleSavePanelOptions('/tmp/support-bundle.tar.gz', code)
      return [options.title ?? '', options.filters?.[0]?.name ?? '']
    },
    fields: ['exportSupportBundleTitle', 'supportBundleFilter'],
    legacyEn: ['Export support bundle', 'Support bundle']
  },
  {
    name: 'update installer — save',
    surfaced: (code) => [updateInstallerSavePanelOptions('/tmp/app.dmg', code).title ?? ''],
    fields: ['saveUpdateInstallerTitle'],
    legacyEn: ['Save the update installer']
  },
  {
    name: 'managed file — save',
    surfaced: (code) => [managedFileSavePanelOptions('/tmp/data.csv', code).title ?? ''],
    fields: ['saveFileTitle'],
    legacyEn: ['Save file']
  },
  {
    name: 'session artifact — save',
    surfaced: (code) => [sessionArtifactSavePanelOptions('/tmp/figure.png', code).title ?? ''],
    fields: ['saveArtifactTitle'],
    legacyEn: ['Save artifact']
  },
  {
    name: 'session artifacts — choose folder',
    surfaced: (code) => [sessionArtifactFolderPanelOptions('/tmp/out', code).title ?? ''],
    fields: ['chooseArtifactFolderTitle'],
    legacyEn: ['Choose where to save artifacts']
  },
  {
    name: 'annotation notes — save',
    surfaced: (code) => {
      const options = annotationSavePanelOptions('notes', code)
      return [options.title, options.filter.name]
    },
    fields: ['saveAnnotationNotesTitle', 'annotationTextFilter'],
    legacyEn: ['Save annotation notes', 'Text']
  },
  {
    name: 'annotated copy — save',
    surfaced: (code) => [annotationSavePanelOptions('annotated-pdf', code).title],
    fields: ['saveAnnotatedCopyTitle'],
    legacyEn: ['Save annotated copy']
  },
  {
    name: 'notebooks — export',
    surfaced: (code) => [notebookExportOpenPanelOptions('/tmp/downloads', code).title ?? ''],
    fields: ['exportNotebooksTitle'],
    legacyEn: ['Export notebooks by kernel']
  }
]

const expectedFor = (code: NativeLocaleCode, fields: Array<keyof FileDialogStrings>): string[] =>
  fields.map((field) => {
    const value = FILE_DIALOG_STRINGS[code][field]
    if (typeof value !== 'string') {
      throw new Error(`${field} is not a plain string; assert it on its own case`)
    }
    return value
  })

describe('OS file panels carry the reader’s language', () => {
  for (const panel of panels) {
    it(`${panel.name} reads its wording from the table`, () => {
      for (const code of NATIVE_LOCALE_CODES) {
        expect(`${code}: ${JSON.stringify(panel.surfaced(code))}`).toBe(
          `${code}: ${JSON.stringify(expectedFor(code, panel.fields))}`
        )
      }
    })

    it(`${panel.name} still says it in English exactly as before`, () => {
      expect(panel.surfaced('en')).toEqual(panel.legacyEn)
    })

    // The failure the tables exist to prevent: the panel opens in, say, German and still shows the
    // English sentence. Compared per string so a partial translation is caught too.
    it(`${panel.name} never hands another language the English sentence`, () => {
      const english = panel.surfaced('en')
      for (const code of NATIVE_LOCALE_CODES) {
        if (code === 'en') continue
        const translated = panel.surfaced(code)
        expect(translated.length).toBe(english.length)
        translated.forEach((value, index) => {
          expect(`${code}[${index}] ${value}`).not.toBe(`${code}[${index}] ${english[index]}`)
        })
      }
    })
  }

  it('keeps the PDF filter name untranslated on the annotated-copy channel', () => {
    for (const code of NATIVE_LOCALE_CODES) {
      const options = annotationSavePanelOptions('annotated-pdf', code)
      // A format token, not a sentence: it is the same three letters in every language, and the
      // extension beside it stays the PDF one (the notes channel is the one that moves to text).
      expect(options.filter.name).toBe('PDF')
      expect(options.filter.extensions).toEqual(['pdf'])
      expect(annotationSavePanelOptions('notes', code).filter.extensions).toEqual(['txt'])
    }
  })

  it('follows the OS locale when the caller passes none', () => {
    try {
      osState.locale = 'de-DE'
      expect(updateInstallerSavePanelOptions('/tmp/app.dmg').title).toBe(
        FILE_DIALOG_STRINGS.de.saveUpdateInstallerTitle
      )
      osState.locale = 'zh-TW'
      expect(connectorConfigOpenPanelOptions().title).toBe(
        FILE_DIALOG_STRINGS['zh-Hant'].importConnectorTitle
      )
      osState.locale = 'pt-BR'
      // Unrecognised languages fall back to English rather than to an empty title.
      expect(managedFileSavePanelOptions('/tmp/data.csv').title).toBe('Save file')
    } finally {
      osState.locale = 'en'
    }
  })
})

describe('notebook overwrite confirm', () => {
  it('defaults to cancelling, never to overwriting the reader’s files', () => {
    const options = notebookOverwritePanelOptions(2, 'a.ipynb, b.ipynb', 'en')
    expect(options.type).toBe('question')
    expect(options.defaultId).toBe(1)
    expect(options.cancelId).toBe(1)
    expect(options.detail).toBe('a.ipynb, b.ipynb')
    expect(options.buttons).toEqual(['Overwrite', 'Cancel'])
  })

  it('counts in English correctly on both sides of one', () => {
    expect(notebookOverwritePanelOptions(1, '', 'en').message).toBe(
      '1 notebook already exists in the chosen directory.'
    )
    expect(notebookOverwritePanelOptions(3, '', 'en').message).toBe(
      '3 notebooks already exist in the chosen directory.'
    )
  })

  // Russian needs three forms; the previous template had one, so a Russian reader was told
  // "3 ноутбуков" — a form no Russian sentence uses there.
  it('uses the three Russian forms', () => {
    const form = (count: number): string =>
      notebookOverwritePanelOptions(count, '', 'ru').message ?? ''
    expect(form(1)).toContain('1 ноутбук ')
    expect(form(3)).toContain('3 ноутбука ')
    expect(form(5)).toContain('5 ноутбуков ')
    expect(form(11)).toContain('11 ноутбуков ')
    expect(form(21)).toContain('21 ноутбук ')
    expect(form(22)).toContain('22 ноутбука ')
  })

  it('keeps a single form where the language has no plural inflection', () => {
    for (const code of ['zh', 'zh-Hant', 'ja', 'ko'] as const) {
      const one = notebookOverwritePanelOptions(1, '', code).message ?? ''
      const many = notebookOverwritePanelOptions(5, '', code).message ?? ''
      expect(one).not.toBe(many)
      // Both carry their own count; the noun does not change shape.
      expect(one).toContain('1')
      expect(many).toContain('5')
    }
  })
})

// The panels only speak their reader's language if the modules that open them stopped carrying the
// sentences. Comments are stripped: naming the sentence a module replaced is documentation, not a
// second copy of it.
describe('the modules that open those panels carry no English dialog literals', () => {
  const stripComments = (source: string): string =>
    source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')

  const callSites: Array<[string, string[]]> = [
    [
      'ipc.ts',
      [
        'Import Connector configuration',
        'Export Connector configuration',
        'Import session package',
        'Save annotation notes',
        'Save annotated copy'
      ]
    ],
    ['session-package/ipc.ts', ['Export session package', 'PureScience session package']],
    ['diagnostics/support-bundle-ipc.ts', ['Export support bundle', 'Support bundle']],
    ['update/service.ts', ['Save the update installer']],
    ['file-save.ts', ['Save file', 'Save artifact', 'Choose where to save artifacts']],
    [
      'notebook/save-ipynb-all.ts',
      [
        'Export notebooks by kernel',
        'Overwrite existing notebooks?',
        'already exist in the chosen directory'
      ]
    ]
  ]

  for (const [relativePath, english] of callSites) {
    it(`${relativePath} draws from the builders`, () => {
      const source = stripComments(readFileSync(join(__dirname, relativePath), 'utf8'))
      expect(source.length).toBeGreaterThan(200)
      expect(source).toContain('native-file-dialogs')
      for (const sentence of english) {
        expect(source).not.toContain(sentence)
      }
    })
  }
})
