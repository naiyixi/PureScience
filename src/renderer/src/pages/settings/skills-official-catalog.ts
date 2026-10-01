// What the panel says about the official skills catalog. Kept as its own function (rather than inline JSX)
// because the three states are three different claims to the user: "not checked yet", "read, and it carries
// no skills section", "could not be read" — and only one of them means the catalog does not exist.

import type { MarketplaceSnapshot } from '../../../../shared/specialist-marketplace'
import type { TranslationKey } from '@/i18n'

type Translate = (key: TranslationKey, vars?: Record<string, string>) => string

export const officialCatalogSentence = (
  snapshot: MarketplaceSnapshot | undefined,
  t: Translate
): string => {
  const catalog = snapshot?.skillsCatalog
  if (!catalog) return t('settings.skillsOfficialCatalogUnread')
  if (catalog.state === 'published') {
    return t('settings.skillsOfficialCatalogPublished', { n: String(catalog.count ?? 0) })
  }
  if (catalog.state === 'absent') return t('settings.skillsOfficialCatalogAbsent')

  // "Could not read it" is only useful with the reason attached, and the reason differs between runs (404
  // versus a timeout): the source's own failure message carries it.
  const failure = snapshot?.failures.find((entry) => entry.sourceId === 'purescience-official')

  return t('settings.skillsOfficialCatalogUnreachable', {
    reason: failure?.message ?? t('settings.skillsOfficialCatalogNoReason')
  })
}
