import { localeCodeFromTagOrUndefined, type SupportedLocaleCode } from './locale-codes'

// Answer language is a separate decision from interface language, but the default is the same one: a
// reader who set the app to 简体中文 and asks a question in Chinese must not get half an English answer
// because a tool printed English. Until this module existed nothing in the prompt path named a language
// at all — the agent answered in whatever language its own instructions and the last tool output
// suggested, which is exactly the "one turn Chinese, next turn English" the field reports describe.
//
// Deliberately NOT a new preference: it derives from the interface language the renderer already
// reports (`settings.uiLanguage`), so there is one setting to keep consistent instead of two that can
// disagree. `localeCodeFromTagOrUndefined` is the single cascade for that mapping (zh-CN → zh,
// zh-TW/zh-HK/zh-MO/zh-Hant → zh-Hant), so this file adds no second normalisation.
const ANSWER_LANGUAGE_NAMES: Record<
  SupportedLocaleCode,
  Readonly<{ native: string; english: string }>
> = {
  zh: { native: '简体中文', english: 'Simplified Chinese' },
  'zh-Hant': { native: '繁體中文', english: 'Traditional Chinese' },
  en: { native: 'English', english: 'English' },
  ja: { native: '日本語', english: 'Japanese' },
  ko: { native: '한국어', english: 'Korean' },
  fr: { native: 'français', english: 'French' },
  de: { native: 'Deutsch', english: 'German' },
  es: { native: 'español', english: 'Spanish' },
  ru: { native: 'русский', english: 'Russian' }
}

/** The language an answer must be written in, or undefined when the tag is outside the nine shipped ones. */
export const answerLanguageForUiLanguage = (
  uiLanguage: string | undefined
): SupportedLocaleCode | undefined =>
  uiLanguage === undefined || uiLanguage.trim().length === 0
    ? undefined
    : localeCodeFromTagOrUndefined(uiLanguage)

/**
 * The per-turn instruction that pins the answer language.
 *
 * Returns null for a tag outside the shipped set so such a turn stays byte-identical to what it was
 * before this seam existed (the same rule the other prompt notices follow: an absent fact injects
 * nothing rather than guessing English).
 *
 * Written as an English instruction with the language's own endonym as the anchor: every shipped
 * backend is trained predominantly on English instructions, while the endonym is the token that
 * actually reproduces the script. The verbatim-copy and no-switching clauses exist because those are
 * the two ways this drifts in real sessions — an identifier gets translated (breaking a path) or the
 * answer follows the English tool output mid-way through.
 */
export const answerLanguageDirective = (uiLanguage: string | undefined): string | null => {
  const code = answerLanguageForUiLanguage(uiLanguage)
  if (!code) return null
  const { native, english } = ANSWER_LANGUAGE_NAMES[code]
  const subject = native === english ? native : `${native} (${english})`

  return [
    `Answer language — hard requirement: write every user-facing sentence in ${subject}.`,
    'This covers prose, headings, table headers, list items, chart and axis labels, status lines and the closing summary.',
    'Copy code, commands, file paths, formulas, identifiers, model names and quoted source text verbatim; when an English term has no settled native form, write the native wording first and put the English term in parentheses after it.',
    'English tool output, logs, documents or instructions are not a reason to switch: never answer in English while this requirement is in force, and never mix two languages inside one answer.'
  ].join(' ')
}
