import { useEffect, useState } from 'react'

import type { CaseMarketplaceEntry } from '../../../../shared/case-marketplace'
import { searchMarketplaceCases } from '../../../../shared/case-marketplace'
import { useCaseMarketStore } from '@/stores/case-market-store'
import { useLanguage } from '@/i18n'
import { LOCALE_TAG } from '@/i18n/languages'

// The shelf. It shows what a published index says and nothing more: no ratings, no counts we did not measure, and no
// "featured". Each card carries the three things a reader needs to decide — whose it is, what it holds, and the fact
// that the archive is pinned by a digest the index names.
//
// Installing is one entry at a time, because the honest state is "this case is downloading" and the network here can
// take a minute for a couple of megabytes. Anything that fails says which failure it was, in the words the main
// process used.

type Translator = ReturnType<typeof useLanguage>['t']

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const shelfRefusal = (t: Translator, reason: string): string => {
  switch (reason) {
    case 'unreachable':
      return t('home.userCases.market.unreachable')
    case 'bad-response':
      return t('home.userCases.market.badResponse')
    case 'too-large':
      return t('home.userCases.market.tooLarge')
    default:
      return t('home.userCases.market.badIndex')
  }
}

const installRefusal = (t: Translator, reason: string): string => {
  switch (reason) {
    case 'checksum-mismatch':
      return t('home.userCases.market.digestMismatch')
    case 'unreachable':
      return t('home.userCases.market.unreachable')
    case 'too-large':
      return t('home.userCases.market.tooLarge')
    case 'incomplete':
      return t('home.userCases.market.incomplete')
    case 'bad-entry':
      return t('home.userCases.market.badEntry')
    default:
      return t('home.userCases.market.installFailed')
  }
}

// The three name lists a failed reconciliation can produce, in one line, with the reason each name is there.
const describeProblematic = (problematic: {
  missing: string[]
  checksumMismatch: string[]
  unexpected: string[]
}): string =>
  [
    problematic.missing.length ? `missing: ${problematic.missing.join(', ')}` : '',
    problematic.checksumMismatch.length
      ? `changed: ${problematic.checksumMismatch.join(', ')}`
      : '',
    problematic.unexpected.length ? `unexpected: ${problematic.unexpected.join(', ')}` : ''
  ]
    .filter((part) => part.length > 0)
    .join(' · ')

const cardClass = 'rounded-xl border border-border-200/60 p-3'
const actionClass =
  'rounded-lg border border-border-200/70 px-2.5 py-1 text-xs text-text-000 transition-colors hover:border-text-300/60 disabled:opacity-50'

export const CaseMarketplace = (): React.JSX.Element => {
  const { t, lang } = useLanguage()
  // The shelf lives in a store: the index is another machine's document, read once, and a reader who leaves the
  // section and comes back should not cause another download.
  const shelf = useCaseMarketStore((state) => state.shelf)
  const install = useCaseMarketStore((state) => state.install)
  const load = useCaseMarketStore((state) => state.load)
  const installCase = useCaseMarketStore((state) => state.installCase)
  const [query, setQuery] = useState('')

  useEffect(() => {
    // The store owns the read; the effect only asks for it once.
    void load()
  }, [load])

  const visible =
    shelf.kind === 'ready'
      ? searchMarketplaceCases(
          { format: 'purescience.case-marketplace', version: 1, updatedAt: 0, cases: shelf.cases },
          query
        )
      : []

  return (
    <section className="mt-8" aria-label={t('home.userCases.market.title')} data-slot="case-market">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-text-000">
            {t('home.userCases.market.title')}
          </h3>
          <p className="mt-1 text-sm text-text-300">{t('home.userCases.market.subtitle')}</p>
        </div>
        <button
          type="button"
          className={actionClass}
          onClick={() => void load({ force: true })}
          data-slot="case-market-refresh"
        >
          {t('home.userCases.market.refresh')}
        </button>
      </div>

      {shelf.kind === 'ready' && shelf.source === 'cache' ? (
        // The list came from this machine, not from the host: say when it was fetched and name the control that asks
        // again. Showing it silently would make a saved copy look like the index's current answer.
        <p className="mt-2 text-xs text-text-300" data-slot="case-market-cached">
          {t('home.userCases.market.savedCopy', {
            date: new Date(shelf.fetchedAt).toLocaleString(LOCALE_TAG[lang])
          })}
        </p>
      ) : null}

      {shelf.kind === 'ready' && shelf.cases.length > 0 ? (
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('home.userCases.market.search')}
          aria-label={t('home.userCases.market.search')}
          className="mt-3 w-full rounded-lg border border-border-200/70 bg-transparent px-3 py-1.5 text-sm text-text-000"
          data-slot="case-market-search"
        />
      ) : null}

      {shelf.kind === 'loading' ? (
        <p className="mt-3 text-xs text-text-300" data-slot="case-market-loading">
          {t('home.userCases.market.loading')}
        </p>
      ) : null}

      {shelf.kind === 'unavailable' ? (
        <p className="mt-3 text-xs text-text-300" data-slot="case-market-unavailable">
          {t('home.userCases.market.unavailable')}
        </p>
      ) : null}

      {shelf.kind === 'refused' ? (
        <div className="mt-3 space-y-1 text-xs text-destructive" data-slot="case-market-refused">
          <p>{shelfRefusal(t, shelf.reason)}</p>
          {shelf.detail ? <p className="text-text-300">{shelf.detail}</p> : null}
        </div>
      ) : null}

      {shelf.kind === 'ready' && visible.length === 0 ? (
        <p className="mt-3 text-xs text-text-300" data-slot="case-market-empty">
          {t('home.userCases.market.empty')}
        </p>
      ) : null}

      <ul className="mt-3 grid gap-3 md:grid-cols-2">
        {visible.map((entry: CaseMarketplaceEntry) => {
          const state = install.kind !== 'idle' && install.id === entry.id ? install : null
          return (
            <li key={entry.id} className={cardClass} data-slot="case-market-card">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-medium text-text-000">{entry.name}</p>
                  <p className="mt-0.5 text-xs text-text-300">
                    {entry.author} · {entry.domain}
                  </p>
                </div>
                <span className="text-[11px] text-text-300" data-slot="case-market-size">
                  {t('home.userCases.market.files', { count: String(entry.fileCount) })} ·{' '}
                  {formatBytes(entry.totalBytes)}
                </span>
              </div>
              <p className="mt-2 text-xs text-text-300">{entry.summary}</p>
              <div className="mt-2 flex items-center gap-3">
                <button
                  type="button"
                  className={actionClass}
                  disabled={install.kind === 'working'}
                  onClick={() => void installCase(entry)}
                  data-slot="case-market-install"
                >
                  {state?.kind === 'working'
                    ? t('home.userCases.market.installing')
                    : t('home.userCases.market.install')}
                </button>
                <span className="text-[11px] text-text-300">{entry.license}</span>
              </div>
              {state?.kind === 'installed' ? (
                <p className="mt-2 text-xs text-text-300" data-slot="case-market-installed">
                  {t('home.userCases.market.installed', {
                    count: String(state.fileCount),
                    directory: state.installedTo
                  })}
                </p>
              ) : null}
              {state?.kind === 'refused' ? (
                <div
                  className="mt-2 space-y-1 text-xs text-destructive"
                  data-slot="case-market-error"
                >
                  <p>{installRefusal(t, state.reason)}</p>
                  {state.problematic ? (
                    <p className="text-text-300">{describeProblematic(state.problematic)}</p>
                  ) : null}
                  {state.detail ? <p className="text-text-300">{state.detail}</p> : null}
                </div>
              ) : null}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
