import { app } from 'electron'

import {
  SUPPORTED_LOCALE_CODES,
  localeCodeFromTag,
  type SupportedLocaleCode
} from '../shared/locale-codes'

// The nine languages the renderer ships. Main-process copy that has no renderer i18n provider to read
// from — a native dialog, a menu item, and the HTML pages served to a browser (the remote-pairing
// page and the OAuth callback page) — resolves the language the way menus and the tray already do:
// Electron's OS locale matched against this same set. The renderer owns the exact in-app preference
// and always wins wherever it can render; main's approximation exists only for the surfaces that are
// drawn outside the renderer, and it is stated as an approximation rather than passed off as the
// user's setting.
//
// The set itself and the tag cascade now live in `src/shared/locale-codes.ts`: the menu and tray
// tables used to carry their own copies, and the copies answered differently for the same OS locale
// (see the zh-MO note there). One source, one answer, and every table typed against it.
export type NativeLocaleCode = SupportedLocaleCode

export const NATIVE_LOCALE_CODES: readonly NativeLocaleCode[] = SUPPORTED_LOCALE_CODES

// Pure, so the cascade itself is unit-testable without Electron: every tag Electron can report
// ('zh-Hant', 'zh-TW', 'zh-HK', 'pt-BR', …) maps deterministically, and anything unrecognised lands
// on English instead of on an empty string.
export const nativeLocaleCodeFrom = (raw: string): NativeLocaleCode => localeCodeFromTag(raw)
export const resolveNativeLocaleCode = (): NativeLocaleCode => {
  try {
    return nativeLocaleCodeFrom(app.getLocale())
  } catch {
    // A unit-test electron mock without an `app` export throws on the interop getter; English is the
    // documented fallback there rather than a crash on a page that only wanted a label.
    return 'en'
  }
}

// A `Record<NativeLocaleCode, T>` cannot be constructed without every language, so a page that
// carries one cannot quietly ship English to a reader of one of the other eight — the compiler is
// the closing gate, not a reviewer's eye.
export const nativeStringsFor = <T>(map: Record<NativeLocaleCode, T>): T =>
  map[resolveNativeLocaleCode()]
