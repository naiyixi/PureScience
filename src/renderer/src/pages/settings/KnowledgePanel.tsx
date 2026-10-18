import { useLanguage } from '@/i18n'
import { BookOpen, FilePlus2, Search, X } from 'lucide-react'
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

// A refresh or a removal can take rows away under a ticked set; a tick for a row that no longer exists would arm a
// removal that has nothing to remove. Dropped here, at the one place a list arrives, rather than in an effect.
const pruneToPresent = (ids: string[], sources: KnowledgeSource[] | undefined): string[] =>
  ids.filter((id) => (sources ?? []).some((source) => source.id === id))

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
  const [busy, setBusy] = useState<
    'list' | 'register' | 'search' | 'sweep' | 'remove' | undefined
  >()
  const [error, setError] = useState<string | undefined>()
  const [note, setNote] = useState<string | undefined>()
  const [page, setPage] = useState(0)
  // Which rows are ticked for a bulk removal, and whether the ticked set has been confirmed once. The armed step
  // exists because a bulk removal is the one action here that cannot be undone by looking at the screen.
  const [selected, setSelected] = useState<string[]>([])
  const [armed, setArmed] = useState(false)

  // Twenty rows is one screen of this panel; anything more and the list stops being scannable. The page is reset
  // whenever a load changes the set out from under it (a removal or a refresh), so a saved page index can never
  // point past the end of a shorter list.
  const PAGE_SIZE = 20
  const allSources = overview?.sources ?? []
  const pageCount = Math.max(1, Math.ceil(allSources.length / PAGE_SIZE))
  // Clamped, not trusted: a refresh can shrink the list while `page` still points past its end.
  const currentPage = Math.min(page, pageCount - 1)
  const pagedSources = allSources.slice(
    currentPage * PAGE_SIZE,
    currentPage * PAGE_SIZE + PAGE_SIZE
  )

  // Ticking is per row, but "select all" acts on what is on screen: a reader can only vouch for rows they can see,
  // and a control that quietly selects rows on other pages would remove sources nobody looked at.
  const pageIds = pagedSources.map((source) => source.id)
  const allOnPageSelected = pageIds.length > 0 && pageIds.every((id) => selected.includes(id))

  const toggleSelected = (sourceId: string): void => {
    setArmed(false)
    setSelected((current) =>
      current.includes(sourceId) ? current.filter((id) => id !== sourceId) : [...current, sourceId]
    )
  }

  const togglePage = (): void => {
    setArmed(false)
    setSelected((current) =>
      allOnPageSelected
        ? current.filter((id) => !pageIds.includes(id))
        : [...new Set([...current, ...pageIds])]
    )
  }

  const loadSources = useCallback(async (): Promise<void> => {
    setBusy('list')
    try {
      const loaded = await window.api.knowledge.listSources()
      setOverview(loaded)
      setSelected((current) => pruneToPresent(current, loaded.sources))
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
        if (!cancelled) {
          setOverview(loaded)
          setSelected((current) => pruneToPresent(current, loaded.sources))
        }
      },
      (cause: unknown) => {
        if (!cancelled) setError(describeError(cause, t('settings.knowledge.loadFailed')))
      }
    )
    return () => {
      cancelled = true
    }
  }, [t])

  const remove = async (sourceId: string): Promise<void> => {
    setBusy('register')
    setNote(undefined)
    try {
      const outcome = await window.api.knowledge.removeSource({ sourceId })
      // The pruned copies are reported rather than assumed: "the row is gone" and "the bytes are gone" are two
      // facts, and a copy another source still names is deliberately kept.
      setNote(
        t('settings.knowledge.removed', {
          count: String(outcome.prunedContents.length)
        })
      )
      setOverview(await window.api.knowledge.listSources())
      setResults(undefined)
      setError(undefined)
    } catch (cause) {
      setError(describeError(cause, t('settings.knowledge.removeFailed')))
    } finally {
      setBusy(undefined)
    }
  }

  // A bulk removal is N removals, not one new operation: each source is removed through the same call a single row
  // uses, so a refusal on the fourth one leaves the first three removed and says so. The sentence afterwards
  // reports what actually happened — a partial run reported as success would be the panel claiming work it did not do.
  const removeSelected = async (): Promise<void> => {
    const targets = allSources.filter((source) => selected.includes(source.id))
    if (targets.length === 0) return
    setBusy('remove')
    setArmed(false)
    setNote(undefined)
    let removed = 0
    let pruned = 0
    const failures: string[] = []
    for (const target of targets) {
      try {
        const outcome = await window.api.knowledge.removeSource({ sourceId: target.id })
        removed += 1
        pruned += outcome.prunedContents.length
      } catch (cause) {
        failures.push(
          `${target.label}: ${describeError(cause, t('settings.knowledge.removeFailed'))}`
        )
      }
    }
    try {
      const loaded = await window.api.knowledge.listSources()
      setOverview(loaded)
      // The ones that refused are still rows, so their ticks stay: the reader can retry exactly those.
      setSelected(pruneToPresent(selected, loaded.sources))
      setResults(undefined)
      setError(undefined)
    } catch (cause) {
      setError(describeError(cause, t('settings.knowledge.loadFailed')))
    }
    setNote(
      failures.length > 0
        ? t('settings.knowledge.bulkRemovePartial', {
            count: String(removed),
            failed: String(failures.length),
            reason: failures[0] ?? ''
          })
        : t('settings.knowledge.bulkRemoved', {
            count: String(removed),
            pruned: String(pruned)
          })
    )
    setBusy(undefined)
  }

  // Copies of fetched bodies outlive the rows that named them in two ways: a register that died between writing
  // the bytes and committing the row, and a deletion that failed. Neither can answer a search, so the sweep
  // deletes them and reports what it actually freed — including the ones it could NOT delete, which stay on disk.
  const sweepCopies = async (): Promise<void> => {
    setBusy('sweep')
    setNote(undefined)
    try {
      const outcome = await window.api.knowledge.sweepCopies()
      // Two findings, two sentences: "nobody references these copies" and "these copies are not the bytes their
      // names claim" call for different responses, and folding the second into the first would let an edited copy
      // read as ordinary housekeeping. The mismatch sentence is emitted on its own when nothing else was found, so
      // "No unused copies to delete" never stands next to a deletion it does not mention.
      const sentences: string[] = []
      if (outcome.failed.length > 0) {
        sentences.push(
          t('settings.knowledge.sweptPartial', {
            count: String(outcome.removed.length),
            failed: String(outcome.failed.length)
          })
        )
      } else if (outcome.removed.length > 0) {
        sentences.push(
          t('settings.knowledge.swept', {
            count: String(outcome.removed.length),
            bytes: String(outcome.bytesFreed)
          })
        )
      } else if (outcome.mismatched.length === 0) {
        sentences.push(t('settings.knowledge.sweptNone'))
      }
      if (outcome.mismatched.length > 0) {
        sentences.push(
          t('settings.knowledge.sweptMismatched', { count: String(outcome.mismatched.length) })
        )
      }
      setNote(sentences.join(' '))
      setError(undefined)
    } catch (cause) {
      setError(describeError(cause, t('settings.knowledge.sweepFailed')))
    } finally {
      setBusy(undefined)
    }
  }

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
          <Button
            size="sm"
            variant="ghost"
            data-testid="knowledge-sweep"
            disabled={busy !== undefined}
            onClick={() => void sweepCopies()}
          >
            {t('settings.knowledge.sweep')}
          </Button>
          {pageIds.length > 0 ? (
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <input
                type="checkbox"
                className="h-3.5 w-3.5"
                data-testid="knowledge-select-page"
                aria-label={t('settings.knowledge.selectPageAll')}
                checked={allOnPageSelected}
                disabled={busy !== undefined}
                onChange={togglePage}
              />
              {t('settings.knowledge.selectPageAll')}
            </label>
          ) : null}
        </div>
        {overview?.lastSweep ? (
          <p className="text-xs text-muted-foreground" data-testid="knowledge-last-sweep">
            {t('settings.knowledge.lastSweep', {
              at: new Date(overview.lastSweep.at).toLocaleString(),
              scanned: String(overview.lastSweep.scanned),
              kept: String(overview.lastSweep.kept),
              removed: String(overview.lastSweep.removed),
              failed: String(overview.lastSweep.failed)
            })}
            {/* A note written before copies were checked against their own digest has no mismatch reading. Absence
                is "not checked then", so nothing is printed for it — never a zero the sweep did not report. */}
            {overview.lastSweep.mismatched !== undefined && overview.lastSweep.mismatched > 0
              ? ` ${t('settings.knowledge.sweptMismatched', {
                  count: String(overview.lastSweep.mismatched)
                })}`
              : null}
          </p>
        ) : overview?.lastSweepUnreadable ? (
          // "No sweep has run" and "we cannot read what the last one did" are different facts; the panel says which
          // one it has instead of letting the second look like the first.
          <p className="text-xs text-destructive" data-testid="knowledge-last-sweep-unreadable">
            {t('settings.knowledge.lastSweepUnreadable')}
          </p>
        ) : null}
        {selected.length > 0 ? (
          <div
            className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-xs"
            data-testid="knowledge-bulk-bar"
          >
            <span>{t('settings.knowledge.selectedCount', { count: String(selected.length) })}</span>
            {armed ? (
              <>
                <Button
                  size="sm"
                  variant="destructive"
                  data-testid="knowledge-bulk-confirm"
                  disabled={busy !== undefined}
                  onClick={() => void removeSelected()}
                >
                  {t('settings.knowledge.bulkRemoveConfirm', { count: String(selected.length) })}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  data-testid="knowledge-bulk-cancel"
                  onClick={() => setArmed(false)}
                >
                  {t('settings.knowledge.bulkRemoveCancel')}
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                data-testid="knowledge-bulk-remove"
                disabled={busy !== undefined}
                onClick={() => setArmed(true)}
              >
                {t('settings.knowledge.bulkRemove')}
              </Button>
            )}
          </div>
        ) : null}
        {overview === undefined ? (
          <p className="text-sm text-muted-foreground">{t('settings.knowledge.loading')}</p>
        ) : overview.unreadable ? (
          // "We could not look" is not "nothing is registered" — the same distinction the search response keeps.
          <p className="text-sm text-destructive">{t('settings.knowledge.unreadable')}</p>
        ) : overview.sources.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('settings.knowledge.empty')}</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {pagedSources.map((source) => (
              <li key={source.id} className="flex items-start gap-2 px-3 py-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-1 h-3.5 w-3.5"
                  data-testid={`knowledge-select-row-${source.id}`}
                  aria-label={t('settings.knowledge.selectSource', { label: source.label })}
                  checked={selected.includes(source.id)}
                  disabled={busy !== undefined}
                  onChange={() => toggleSelected(source.id)}
                />
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-medium">{source.label}</span>
                    <span className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">{source.kind}</span>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={t('settings.knowledge.remove', { label: source.label })}
                        disabled={busy !== undefined}
                        onClick={() => void remove(source.id)}
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </span>
                  </div>
                  <span className="break-all text-xs text-muted-foreground">{source.location}</span>
                  {/* The digest is shown, not summarised: a reader can check it against the file. */}
                  <span className="font-mono text-xs text-muted-foreground">
                    sha256 {shortDigest(source.fingerprint.value)} · {source.fingerprint.bytes} B
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
        {pageCount > 1 ? (
          <div className="flex items-center justify-end gap-2" data-testid="knowledge-pager">
            <Button
              size="sm"
              variant="ghost"
              disabled={page === 0}
              onClick={() => setPage((current) => Math.max(0, current - 1))}
            >
              {t('settings.knowledge.previous')}
            </Button>
            <span className="text-xs text-muted-foreground">
              {t('settings.knowledge.page', {
                page: String(page + 1),
                pages: String(pageCount)
              })}
            </span>
            <Button
              size="sm"
              variant="ghost"
              disabled={page >= pageCount - 1}
              onClick={() => setPage((current) => Math.min(pageCount - 1, current + 1))}
            >
              {t('settings.knowledge.next')}
            </Button>
          </div>
        ) : null}
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
