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
// Environment-free on purpose: the renderer runs in the main process, the window and tests alike.

export type CslTermValue = { readonly single: string; readonly multiple: string }
export type CslTermForm = 'long' | 'short' | 'symbol'
export type CslTerm = Partial<Record<CslTermForm, CslTermValue>>
export type CslTermTable = Readonly<Record<string, CslTerm>>

// Chinese labels do not inflect, so single and multiple are the same word; keeping both fields means
// the plural rule stays one rule for every language.
const both = (value: string): CslTermValue => ({ single: value, multiple: value })

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
  // APA prints this one directly (`<text prefix="1" term="page-range-delimiter"/>`) rather than as a
  // label, so it lives here as well as in the locale file.
  'page-range-delimiter': { long: both('–') }
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
  'page-range-delimiter': { long: both('～') }
}

export const localeLanguage = (locale: string): string =>
  (locale.split(/[-_]/)[0] ?? '').toLowerCase()

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
