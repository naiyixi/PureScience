import { useLanguage } from '@/i18n'
import { BookOpen, FilePlus2, Search } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import type {
  KnowledgeOverview,
  KnowledgeRegistration,
  KnowledgeSearchResponse,
  KnowledgeSource
} from '../../../../shared/knowledge'

const describeError = (error: unknown, fallback: string): string =>
  error instanceof Error ? error.message : fallback

const shortDigest = (digest: string): string => `${digest.slice(0, 12)}…`

const describeLocator = (response: KnowledgeSearchResponse): string => {
  const locator = response.results[0]?.locator
  if (!locator) return ''
  if (locator.kind === 'file') return `${locator.path}:${locator.startLine}-${locator.endLine}`
  if (locator.kind === 'url') return locator.url
  return `${locator.path}#${locator.page}`
}

// The knowledge store's window surface. Everything it shows comes from the same module the model's tools use, so
// what a reader sees here and what an agent gets cannot drift apart — including the refusals, which are shown in
// the store's own words (`Knowledge source refused (source-outside-roots): …`).
const KnowledgePanel = (): React.JSX.Element => {
  const { t } = useLanguage()
  const [overview, setOverview] = useState<KnowledgeOverview | undefined>()
  const [kind, setKind] = useState<KnowledgeRegistration['kind']>('file')
  const [location, setLocation] = useState('')
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<KnowledgeSearchResponse | undefined>()
  const [busy, setBusy] = useState<'list' | 'register' | 'search' | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [note, setNote] = useState<string | undefined>()

  const loadSources = useCallback(async (): Promise<void> => {
    setBusy('list')
    try {
      setOverview(await window.api.knowledge.listSources())
      setError(undefined)
    } catch (cause) {
      setError(describeError(cause, t('settings.knowledge.loadFailed')))
    } finally {
      setBusy(undefined)
    }
  }, [t])

  // The initial read is written out rather than routed through `loadSources`, so the state updates happen in the
  // promise's own callbacks instead of synchronously inside the effect (one render, and a cancel path that does
  // not set state on an unmounted panel).
  useEffect(() => {
    let cancelled = false
    void window.api.knowledge.listSources().then(
      (loaded) => {
        if (!cancelled) setOverview(loaded)
      },
      (cause: unknown) => {
        if (!cancelled) setError(describeError(cause, t('settings.knowledge.loadFailed')))
      }
    )
    return () => {
      cancelled = true
    }
  }, [t])

  const register = async (): Promise<void> => {
    const trimmed = location.trim()
    if (!trimmed) return
    setBusy('register')
    setNote(undefined)
    try {
      const registered: KnowledgeSource[] = await window.api.knowledge.registerSource(
        kind === 'url' ? { kind, url: trimmed } : { kind, path: trimmed }
      )
      setNote(t('settings.knowledge.registered', { count: String(registered.length) }))
      setLocation('')
      setOverview(await window.api.knowledge.listSources())
      setError(undefined)
    } catch (cause) {
      setError(describeError(cause, t('settings.knowledge.registerFailed')))
    } finally {
      setBusy(undefined)
    }
  }

  const search = async (): Promise<void> => {
    const trimmed = query.trim()
    if (!trimmed) return
    setBusy('search')
    try {
      setResults(await window.api.knowledge.search({ text: trimmed }))
      setError(undefined)
    } catch (cause) {
      setError(describeError(cause, t('settings.knowledge.searchFailed')))
    } finally {
      setBusy(undefined)
    }
  }

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h2 className="text-base font-medium">{t('settings.knowledge.title')}</h2>
        <p className="text-sm text-muted-foreground">{t('settings.knowledge.description')}</p>
      </header>

      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <BookOpen className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-medium">{t('settings.knowledge.sources')}</h3>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy !== undefined}
            onClick={() => void loadSources()}
          >
            {t('settings.knowledge.refresh')}
          </Button>
        </div>
        {overview === undefined ? (
          <p className="text-sm text-muted-foreground">{t('settings.knowledge.loading')}</p>
        ) : overview.unreadable ? (
          // "We could not look" is not "nothing is registered" — the same distinction the search response keeps.
          <p className="text-sm text-destructive">{t('settings.knowledge.unreadable')}</p>
        ) : overview.sources.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('settings.knowledge.empty')}</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {overview.sources.map((source) => (
              <li key={source.id} className="flex flex-col gap-1 px-3 py-2 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-medium">{source.label}</span>
                  <span className="text-xs text-muted-foreground">{source.kind}</span>
                </div>
                <span className="break-all text-xs text-muted-foreground">{source.location}</span>
                {/* The digest is shown, not summarised: a reader can check it against the file. */}
                <span className="font-mono text-xs text-muted-foreground">
                  sha256 {shortDigest(source.fingerprint.value)} · {source.fingerprint.bytes} B
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-2">
        <div className="flex items-center gap-2">
          <FilePlus2 className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-medium">{t('settings.knowledge.register')}</h3>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label={t('settings.knowledge.kind')}
            className="h-9 rounded-md border bg-background px-2 text-sm"
            value={kind}
            onChange={(event) => setKind(event.target.value as KnowledgeRegistration['kind'])}
          >
            <option value="file">{t('settings.knowledge.kindFile')}</option>
            <option value="folder">{t('settings.knowledge.kindFolder')}</option>
            <option value="url">{t('settings.knowledge.kindUrl')}</option>
          </select>
          <input
            aria-label={t('settings.knowledge.location')}
            className="h-9 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm"
            placeholder={kind === 'url' ? 'https://…' : '/absolute/path'}
            value={location}
            onChange={(event) => setLocation(event.target.value)}
          />
          <Button
            size="sm"
            disabled={busy !== undefined || !location.trim()}
            onClick={() => void register()}
          >
            {t('settings.knowledge.registerAction')}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">{t('settings.knowledge.registerHint')}</p>
      </section>

      <section className="space-y-2">
        <div className="flex items-center gap-2">
          <Search className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-medium">{t('settings.knowledge.search')}</h3>
        </div>
        <div className="flex items-center gap-2">
          <input
            aria-label={t('settings.knowledge.query')}
            className="h-9 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void search()
            }}
          />
          <Button
            size="sm"
            disabled={busy !== undefined || !query.trim()}
            onClick={() => void search()}
          >
            {t('settings.knowledge.searchAction')}
          </Button>
        </div>
        {results ? (
          <div className="space-y-2 text-sm">
            <p className="text-xs text-muted-foreground">
              {t('settings.knowledge.status', {
                status: results.status,
                indexed: String(results.coverage.indexed),
                pending: String(results.coverage.pending)
              })}
            </p>
            {results.results.length === 0 ? (
              <p className="text-muted-foreground">{t('settings.knowledge.noResults')}</p>
            ) : (
              <ul className="divide-y rounded-md border">
                {results.results.map((result) => (
                  <li
                    key={`${result.sourceId}:${describeLocator(results)}`}
                    className="space-y-1 px-3 py-2"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-medium">{result.label}</span>
                      <span className="text-xs text-muted-foreground">
                        {result.matchedBy ?? 'lexical'}
                      </span>
                    </div>
                    <span className="break-all font-mono text-xs text-muted-foreground">
                      {result.locator.kind === 'file'
                        ? `${result.locator.path}:${result.locator.startLine}-${result.locator.endLine}`
                        : result.locator.kind === 'url'
                          ? result.locator.url
                          : `${result.locator.path}#${result.locator.page}`}
                    </span>
                    <span className="block font-mono text-xs text-muted-foreground">
                      sha256 {shortDigest(result.sha256)}
                      {result.stale ? ` · ${t('settings.knowledge.stale')}` : ''}
                      {result.unreadable ? ` · ${t('settings.knowledge.unreadableRow')}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}
      </section>

      {note ? <p className="text-sm text-muted-foreground">{note}</p> : null}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </div>
  )
}

export { KnowledgePanel }
