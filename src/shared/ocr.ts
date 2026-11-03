// OCR is only as good as the language pack that reads it: English tesseract reading a Chinese scan returns
// plausible-looking Latin noise, and a reader who is not told that will believe it. So the nine languages this
// product is written in are mapped to their tessdata codes once, here, and anything else is refused by name.
export type OcrLanguageCode =
  'eng' | 'chi_sim' | 'chi_tra' | 'jpn' | 'kor' | 'deu' | 'fra' | 'spa' | 'rus'

export type OcrLanguage = {
  code: OcrLanguageCode
  // The UI language this pack serves, spelled the way the i18n directory spells it.
  uiLanguage: string
  // What tesseract calls the pack in `--list-langs` output and in tessdata/<code>.traineddata.
  packFile: string
}

export const OCR_LANGUAGES: OcrLanguage[] = [
  { code: 'eng', uiLanguage: 'en', packFile: 'eng.traineddata' },
  { code: 'chi_sim', uiLanguage: 'zh', packFile: 'chi_sim.traineddata' },
  { code: 'chi_tra', uiLanguage: 'zh-Hant', packFile: 'chi_tra.traineddata' },
  { code: 'jpn', uiLanguage: 'ja', packFile: 'jpn.traineddata' },
  { code: 'kor', uiLanguage: 'ko', packFile: 'kor.traineddata' },
  { code: 'deu', uiLanguage: 'de', packFile: 'deu.traineddata' },
  { code: 'fra', uiLanguage: 'fr', packFile: 'fra.traineddata' },
  { code: 'spa', uiLanguage: 'es', packFile: 'spa.traineddata' },
  { code: 'rus', uiLanguage: 'ru', packFile: 'rus.traineddata' }
]

const BY_UI_LANGUAGE = new Map<string, OcrLanguage>(
  OCR_LANGUAGES.map((entry) => [entry.uiLanguage, entry])
)
const BY_CODE = new Map<string, OcrLanguage>(OCR_LANGUAGES.map((entry) => [entry.code, entry]))

/** The pack that serves a UI language. `en-GB` and `zh-CN` resolve to their base language; nothing is guessed. */
export const ocrLanguageForUi = (uiLanguage: string): OcrLanguage | undefined => {
  const exact = BY_UI_LANGUAGE.get(uiLanguage)
  if (exact) return exact
  const base = uiLanguage.split('-')[0] ?? ''
  const byBase = BY_UI_LANGUAGE.get(base)
  if (byBase) return byBase
  // A traditional-Chinese UI is the one case where the region matters: zh-Hant must not fall back to chi_sim.
  if (/^zh-(hant|tw|hk|mo)$/i.test(uiLanguage)) return BY_CODE.get('chi_tra')
  return undefined
}

export const ocrLanguageByCode = (code: string): OcrLanguage | undefined =>
  BY_CODE.get(code as OcrLanguageCode)

/**
 * Parses `tesseract --list-langs`, which prints a header line and then one code per line. It is parsed rather
 * than sniffed for a filename so a locale's output cannot turn a missing pack into an installed one.
 */
export const parseTesseractLanguages = (output: string): OcrLanguageCode[] => {
  const codes: OcrLanguageCode[] = []
  for (const rawLine of output.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('List of available')) continue
    if (!BY_CODE.has(line)) continue
    codes.push(line as OcrLanguageCode)
  }
  return codes
}

// What the caller does when the pack is missing is the caller's business; the names it needs to say so are here.
export const missingOcrPack = (
  language: OcrLanguage,
  installed: readonly OcrLanguageCode[]
): { code: OcrLanguageCode; packFile: string; installed: OcrLanguageCode[] } => ({
  code: language.code,
  packFile: language.packFile,
  installed: [...installed]
})
