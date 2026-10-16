import { useEffect, useState } from 'react'

import { Badge } from '@/components/ui/badge'
import { useLanguage } from '@/i18n'
import { cn } from '@/lib/utils'

import { formatWeightSize } from '../../../../shared/engine-catalog'
import { SettingsSection } from './SettingsLayout'

// Local parsing models: the assets this app parses documents and figures with.
//
// This section is the reader's side of the manifest that ships inside the app. Three things it refuses to
// do, each deliberately:
//   * it does not put a location on screen. The reading it renders is the pathless projection the main
//     process returns (`ModelWeightManifestReport` + entries with no url and no path) — the renderer asks
//     for a model id and never names a host, so this surface cannot become a way to fetch an arbitrary URL.
//   * it does not offer a download that cannot run. While the manifest is absent or unusable the section
//     says which of those it is and refuses to show a button at all, rather than a control that always
//     fails.
//   * it does not dress fetching up as parsing. These bytes are fetched and verified here; wiring them into
//     the document/figure parsers is a separate piece of work, and the section says so in words instead of
//     implying that a green badge means the app now recognises chemical structures.
//
// What it *is*: the window's own entry to the same fetch the main process performs — a real download whose
// bytes must match the published SHA256 before anything is cached, with the refusal's own sentence shown
// verbatim. Nothing is downloaded before the reader ticks the consent box; the button is disabled until
// they have, so a `consent: true` leaving this window can only come from a person who read what it costs.

type LocalParsingModelsReading = Awaited<
  ReturnType<typeof window.api.settings.getLocalParsingModels>
>
type LocalParsingModelRow = LocalParsingModelsReading['models'][number]
type LocalParsingDownloadResult = Awaited<
  ReturnType<typeof window.api.settings.downloadLocalParsingModel>
>

const ModelCard = ({
  model,
  onDownloaded
}: {
  model: LocalParsingModelRow
  onDownloaded: () => void
}): React.JSX.Element => {
  const { t } = useLanguage()
  const [consent, setConsent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<LocalParsingDownloadResult | null>(null)

  const download = async (): Promise<void> => {
    setBusy(true)
    try {
      setOutcome(await window.api.settings.downloadLocalParsingModel({ id: model.id, consent }))
    } catch (error) {
      console.error(t('settings.localParsingModelsLoadFailed'), error)
    } finally {
      setBusy(false)
      onDownloaded()
    }
  }

  // The facts a reader can check against the manifest themselves: where the bytes come from, under which
  // licence, how big they are, and the digest that has to match before the file is kept.
  const facts = [
    model.revision,
    model.publisher,
    model.license,
    formatWeightSize(model.bytes),
    `sha256 ${model.sha256.slice(0, 12)}…`
  ]

  return (
    <div
      data-slot="local-parsing-model-row"
      data-model-id={model.id}
      data-model-installed={model.installed ? 'true' : 'false'}
      className="rounded-xl border border-border px-3 py-3"
    >
      <div className="flex items-start justify-between gap-3">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="truncate font-mono text-sm text-foreground">{model.id}</span>
          <span className="truncate font-mono text-xs text-muted-foreground">{model.kind}</span>
        </span>
        <Badge
          variant="outline"
          className={cn(
            'shrink-0',
            model.installed
              ? 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-400'
              : 'text-muted-foreground'
          )}
        >
          {model.installed
            ? t('settings.localParsingModelsInstalled')
            : t('settings.localParsingModelsMissing')}
        </Badge>
      </div>
      <p className="mt-1.5 font-mono text-xs leading-5 text-muted-foreground">
        {facts.join(' · ')}
      </p>
      {model.publisherMd5 ? (
        <p className="mt-0.5 font-mono text-xs text-muted-foreground">
          md5 {model.publisherMd5} ({t('settings.localParsingModelsPublisherMd5Label')})
        </p>
      ) : null}

      {model.installed ? null : (
        <div className="mt-3 space-y-2">
          <label className="flex items-start gap-2 text-xs leading-5 text-muted-foreground">
            <input
              type="checkbox"
              className="mt-0.5"
              data-testid={`local-parsing-consent-${model.id}`}
              checked={consent}
              onChange={(event) => setConsent(event.target.checked)}
            />
            <span>
              {t('settings.localParsingModelsConsent', { size: formatWeightSize(model.bytes) })}
            </span>
          </label>
          <button
            type="button"
            data-testid={`local-parsing-download-${model.id}`}
            disabled={!consent || busy}
            onClick={() => void download()}
            className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-foreground transition-colors duration-150 hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none"
          >
            {busy
              ? t('settings.localParsingModelsDownloading')
              : t('settings.localParsingModelsDownload')}
          </button>
        </div>
      )}

      {outcome ? (
        <p
          data-testid={`local-parsing-outcome-${model.id}`}
          data-outcome-status={outcome.status}
          className="mt-2 text-xs leading-5 text-muted-foreground"
        >
          {outcome.message}
        </p>
      ) : null}
    </div>
  )
}

export function LocalParsingModelsSection({
  separated
}: {
  separated?: boolean
}): React.JSX.Element {
  const { t } = useLanguage()
  const [reading, setReading] = useState<LocalParsingModelsReading | null>(null)
  const [reloadToken, setReloadToken] = useState(0)
  // Whether this window has the bridge at all is known while rendering — reading it here keeps the effect
  // free of a synchronous setState (which cascades renders), and it is the same question either way.
  const read =
    typeof window.api?.settings?.getLocalParsingModels === 'function'
      ? window.api.settings.getLocalParsingModels
      : undefined

  useEffect(() => {
    // Guarded like the app-icon section: the channel is absent in web mode, and reading it optionally keeps
    // a missing bridge from tearing down the whole settings surface during commit.
    if (!read) return
    let active = true
    void Promise.resolve(read())
      .then((result) => {
        if (active) setReading(result)
      })
      .catch((error: unknown) => {
        console.error(t('settings.localParsingModelsLoadFailed'), error)
      })
    return () => {
      active = false
    }
  }, [t, read, reloadToken])

  const report = reading?.report
  const models = reading?.models ?? []

  return (
    <SettingsSection
      title={t('settings.localParsingModels')}
      aria-label={t('settings.localParsingModels')}
      description={t('settings.localParsingModelsHint')}
      separated={separated ?? true}
    >
      <div
        data-slot="local-parsing-models"
        data-testid="local-parsing-models"
        data-report-state={report?.state ?? 'loading'}
        className="max-w-md space-y-3"
      >
        <p className="text-xs leading-5 text-muted-foreground">
          {t('settings.localParsingModelsIntro')}
        </p>
        {/* Said here, in the section's own words, because a downloaded badge would otherwise read as
            "this app now parses figures with it". */}
        <p className="text-xs leading-5 text-muted-foreground">
          {t('settings.localParsingModelsNotParsingYet')}
        </p>

        {read === undefined ? (
          <p className="text-xs leading-5 text-muted-foreground">
            {t('settings.localParsingModelsUnavailable')}
          </p>
        ) : report === undefined ? (
          <p className="text-xs leading-5 text-muted-foreground">
            {t('settings.localParsingModelsLoading')}
          </p>
        ) : report.state === 'absent' ? (
          <p className="text-xs leading-5 text-muted-foreground">
            {t('settings.localParsingModelsAbsent')}
          </p>
        ) : report.state === 'invalid' ? (
          <div className="space-y-1">
            <p className="text-xs leading-5 text-rose-600 dark:text-rose-400">
              {t('settings.localParsingModelsInvalid')}
            </p>
            {report.problems.map((problem) => (
              <p
                key={`${problem.index}-${problem.field}`}
                data-slot="local-parsing-model-problem"
                className="font-mono text-xs leading-5 text-muted-foreground"
              >
                #{problem.index} {problem.field}: {problem.message}
              </p>
            ))}
          </div>
        ) : models.length === 0 ? (
          <p className="text-xs leading-5 text-muted-foreground">
            {t('settings.localParsingModelsEmpty')}
          </p>
        ) : (
          <div className="space-y-3">
            {models.map((model) => (
              <ModelCard
                key={model.id}
                model={model}
                onDownloaded={() => setReloadToken((token) => token + 1)}
              />
            ))}
          </div>
        )}
      </div>
    </SettingsSection>
  )
}
