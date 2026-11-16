// The nine languages this product ships, in ONE place.
//
// Three separate surfaces have to agree on this set: the renderer's dictionaries, the native surfaces
// drawn outside the renderer (application menu, tray, native dialogs, file panels), and the HTML pages
// served to a browser (remote pairing, OAuth callback). A language missing from any one of them ships
// English to that reader and nothing at runtime notices — so the set lives here, where both tsconfig
// projects can import it, and every per-language table is typed `Record<SupportedLocaleCode, T>`.
// The compiler is then the closing gate: a table with eight languages no longer builds.
//
// This module must stay dependency-free (no `electron`, no `node:*`): `src/shared/**` is compiled by
// both the node and the web project, and the renderer reads the same codes.
export type SupportedLocaleCode = 'zh' | 'zh-Hant' | 'en' | 'ja' | 'ko' | 'fr' | 'de' | 'es' | 'ru'

// Same order the renderer's language picker uses, so a list built from this reads naturally.
export const SUPPORTED_LOCALE_CODES: readonly SupportedLocaleCode[] = [
  'zh',
  'zh-Hant',
  'en',
  'ja',
  'ko',
  'fr',
  'de',
  'es',
  'ru'
]

// Pure on purpose: the cascade is the piece that used to be copy-pasted (four times, with slightly
// different answers), so it has to be unit-testable without starting Electron.
//
// Two normalisations the callers actually hit:
//   - some platforms report POSIX-style tags (`zh_TW`), so underscores become hyphens;
//   - Traditional Chinese is signalled either by the script subtag (`zh-Hant`) or by a region that
//     writes it (`zh-TW`, `zh-HK`, `zh-MO`). Macau was the case where the copies disagreed: the menu
//     table answered Traditional and the native dialogs answered Simplified for the same OS locale.
//
// An unsupported tag answers `undefined` here rather than English, because both answers have a real
// call site: the native surfaces must always draw *some* label (they take the English fallback below),
// while the renderer's "follow the system language" preference has to tell "this browser asked for a
// language we ship" apart from "it asked for Portuguese, so use English".
export const localeCodeFromTagOrUndefined = (raw: string): SupportedLocaleCode | undefined => {
  const tag = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/_/g, '-')
  const [primary, ...subtags] = tag.split('-')

  switch (primary) {
    case 'zh': {
      const traditional =
        subtags.includes('hant') ||
        subtags.some((part) => part === 'tw' || part === 'hk' || part === 'mo')
      return traditional ? 'zh-Hant' : 'zh'
    }
    case 'ja':
      return 'ja'
    case 'ko':
      return 'ko'
    case 'fr':
      return 'fr'
    case 'de':
      return 'de'
    case 'es':
      return 'es'
    case 'ru':
      return 'ru'
    case 'en':
      return 'en'
    default:
      return undefined
  }
}

// Anything outside the nine lands on English rather than on an empty label.
export const localeCodeFromTag = (raw: string): SupportedLocaleCode =>
  localeCodeFromTagOrUndefined(raw) ?? 'en'
