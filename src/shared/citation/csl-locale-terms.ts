// CSL locale terms for the labels this renderer prints.
//
// A style never spells "vol." or "第 21 卷" itself: it names a term (`<label variable="volume"
// form="short"/>`, `<text term="volume"/>`) and the locale file supplies the words. A full CSL
// locale is ~30 KB per language, so this carries only the terms the supported constructs can reach,
// read from the published locale files rather than invented:
//
//   locales-en-US.xml  sha256 ac864c7c21166b4390d82c31792cdc509400727fa0060b43d8aa17e07f9cb079
//   locales-zh-CN.xml  sha256 95cebc667f2da8fb5b9864e49941e3f867d59f79feba929bc58e8ed6bfd4d582
//
// A term this table does not carry prints nothing and is named in the import report
// (`term:<name>` / `label:<variable>`), so a Chinese entry never silently falls back to an English
// word. A style's own `<locale><terms>` block overrides these at import time (GB/T 7714 spells the
// edition label 版 while the zh-CN locale spells it 版本).
//
// The same files also carry the locale's month names and date formats. A `<date>` node with no
// `<date-part>` children asks for one of those formats (`form="text"` / `form="numeric"`), and a
// date-part asking for a month prints a name; without both, every style that prints an access date
// could only ever print its year.
//
// Environment-free on purpose: the renderer runs in the main process, the window and tests alike.

export type CslTermValue = { readonly single: string; readonly multiple: string }
export type CslTermForm = 'long' | 'short' | 'symbol'
export type CslTerm = Partial<Record<CslTermForm, CslTermValue>>
export type CslTermTable = Readonly<Record<string, CslTerm>>

// Chinese labels do not inflect, so single and multiple are the same word; keeping both fields means
// the plural rule stays one rule for every language.
const both = (value: string): CslTermValue => ({ single: value, multiple: value })

// Month names, spelled the way the locale file spells them (`month-01` … `month-12`, long and short
// forms). A `<date-part name="month"/>` with the default long form prints these, which is why a date
// without them could only ever print its year.
const monthTerms = (long: readonly string[], short: readonly string[]): Record<string, CslTerm> =>
  Object.fromEntries(
    long.map((name, index) => [
      `month-${String(index + 1).padStart(2, '0')}`,
      { long: both(name), short: both(short[index] ?? name) }
    ])
  )

const EN_MONTHS_LONG = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December'
] as const
const EN_MONTHS_SHORT = [
  'Jan.',
  'Feb.',
  'Mar.',
  'Apr.',
  'May',
  'June',
  'July',
  'Aug.',
  'Sept.',
  'Oct.',
  'Nov.',
  'Dec.'
] as const
const ZH_MONTHS_LONG = [
  '一月',
  '二月',
  '三月',
  '四月',
  '五月',
  '六月',
  '七月',
  '八月',
  '九月',
  '十月',
  '十一月',
  '十二月'
] as const
const ZH_MONTHS_SHORT = [
  '1月',
  '2月',
  '3月',
  '4月',
  '5月',
  '6月',
  '7月',
  '8月',
  '9月',
  '10月',
  '11月',
  '12月'
] as const

const EN_TERMS: CslTermTable = {
  volume: {
    long: { single: 'volume', multiple: 'volumes' },
    short: { single: 'vol.', multiple: 'vols.' }
  },
  issue: {
    long: { single: 'issue', multiple: 'issues' },
    short: { single: 'no.', multiple: 'nos.' }
  },
  page: { long: { single: 'page', multiple: 'pages' }, short: { single: 'p.', multiple: 'pp.' } },
  edition: {
    long: { single: 'edition', multiple: 'editions' },
    short: { single: 'ed.', multiple: 'eds.' }
  },
  chapter: {
    long: { single: 'chapter', multiple: 'chapters' },
    short: { single: 'chap.', multiple: 'chaps.' }
  },
  section: {
    long: { single: 'section', multiple: 'sections' },
    short: { single: '§', multiple: '§§' }
  },
  paragraph: {
    long: { single: 'paragraph', multiple: 'paragraphs' },
    short: { single: 'para.', multiple: 'paras.' }
  },
  and: { long: both('and') },
  in: { long: both('in') },
  'et-al': { long: both('et al.') },
  accessed: { long: both('accessed') },
  // Ordinal suffixes for `<number form="ordinal"/>` ("2nd ed."). en-US spells a suffix; the locale's
  // own `ordinal` is the fallback and 11–13 keep the plain one. zh-CN leaves `ordinal` empty, so a
  // Chinese edition prints the bare number and its label (2 版) — see ZH_TERMS.
  ordinal: { long: both('th') },
  'ordinal-01': { long: both('st') },
  'ordinal-02': { long: both('nd') },
  'ordinal-03': { long: both('rd') },
  'ordinal-11': { long: both('th') },
  'ordinal-12': { long: both('th') },
  'ordinal-13': { long: both('th') },
  // APA prints this one directly (`<text prefix="1" term="page-range-delimiter"/>`) rather than as a
  // label, so it lives here as well as in the locale file.
  'page-range-delimiter': { long: both('–') },
  ...monthTerms(EN_MONTHS_LONG, EN_MONTHS_SHORT)
}

const ZH_TERMS: CslTermTable = {
  volume: { long: both('卷'), short: both('卷') },
  issue: { long: both('期'), short: both('期') },
  page: { long: both('页'), short: both('页') },
  edition: { long: both('版本'), short: both('版') },
  chapter: { long: both('章') },
  section: { long: both('节') },
  paragraph: { long: both('段落') },
  and: { long: both('和') },
  in: { long: both('收入') },
  'et-al': { long: both('等') },
  accessed: { long: both('见于') },
  // zh-CN locale spells `<term name="ordinal"/>` as an empty value: Chinese ordinals take no suffix.
  ordinal: { long: both('') },
  'page-range-delimiter': { long: both('～') },
  ...monthTerms(ZH_MONTHS_LONG, ZH_MONTHS_SHORT)
}

// A `<date>` node with no `<date-part>` children takes its parts from the locale's own date format
// (`<locale><date form="text">` / `form="numeric"`). Copied verbatim from the two published locale
// files named at the top of this file, affixes included: en-US text reads `November 21, 2026`,
// numeric `11/21/2026`; zh-CN text reads `2026年11月21日`, numeric `2026-11-21`.
export type CslDatePartSpec = {
  readonly name: string
  readonly form?: string
  readonly prefix?: string
  readonly suffix?: string
}
export type CslDateForms = Readonly<Partial<Record<'text' | 'numeric', readonly CslDatePartSpec[]>>>

const EN_DATE_FORMS: CslDateForms = {
  text: [{ name: 'month', suffix: ' ' }, { name: 'day', suffix: ', ' }, { name: 'year' }],
  numeric: [
    { name: 'month', form: 'numeric-leading-zeros', suffix: '/' },
    { name: 'day', form: 'numeric-leading-zeros', suffix: '/' },
    { name: 'year' }
  ]
}

const ZH_DATE_FORMS: CslDateForms = {
  text: [
    { name: 'year', suffix: '年' },
    { name: 'month', form: 'numeric', suffix: '月' },
    { name: 'day', suffix: '日' }
  ],
  numeric: [
    { name: 'year' },
    { name: 'month', form: 'numeric-leading-zeros', prefix: '-' },
    { name: 'day', form: 'numeric-leading-zeros', prefix: '-' }
  ]
}

export const localeLanguage = (locale: string): string =>
  (locale.split(/[-_]/)[0] ?? '').toLowerCase()

export const baseCslDateForms = (locale: string): CslDateForms =>
  localeLanguage(locale) === 'zh' ? ZH_DATE_FORMS : EN_DATE_FORMS

export const baseCslTerms = (locale: string): CslTermTable =>
  localeLanguage(locale) === 'zh' ? ZH_TERMS : EN_TERMS

// A style's own `<locale xml:lang="zh">` block applies to any zh-* locale, and a block with no
// xml:lang applies to every language (CSL 1.0.2: a locale without xml:lang is not language-bound).
export const localeBlockMatches = (blockLanguage: string | undefined, locale: string): boolean => {
  if (blockLanguage === undefined || blockLanguage === '') return true
  const block = blockLanguage.toLowerCase()
  const target = locale.toLowerCase()
  return block === target || localeLanguage(block) === localeLanguage(target)
}

// `form` falls back to `long` the way a CSL processor does when the requested form is absent
// ("verb" has no table of its own here).
export const resolveCslTerm = (
  terms: CslTermTable,
  name: string,
  form: string | undefined,
  plural: boolean
): string | undefined => {
  const entry = terms[name]
  if (entry === undefined) return undefined
  const requested = (form ?? 'long') as CslTermForm
  const value = entry[requested] ?? entry.long
  if (value === undefined) return undefined
  return plural ? value.multiple : value.single
}
