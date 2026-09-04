// Active UI locale registry: date/time formatters follow the interface language
// instead of the browser/OS locale. The i18n provider syncs this on language
// change (mirroring setRelativeTimeLanguage in format-relative-time).
let activeLocale = 'en-US'

export const setUiLocale = (locale: string): void => {
  activeLocale = locale || 'en-US'
}

export const getUiLocale = (): string => activeLocale
