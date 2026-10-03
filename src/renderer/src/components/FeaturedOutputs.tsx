import type { JobSummary } from '../../../shared/compute'
import { useLanguage } from '@/i18n'

// What a finished remote job actually produced, shown on the job it belongs to. The result payload already
// carried three things no surface read: which outputs were featured, which files were left on the remote
// workdir (each with its size and the reason it stayed there), and — when the harvest itself failed — the
// error together with the workdir that is deliberately preserved so the files can still be fetched by hand.
//
// A file list without its reasons is a list a reader cannot act on, so every left-behind entry carries its
// own reason; and a payload that reports more files than it lists says so rather than quietly showing a
// subset, which would read as "this is everything".
export function FeaturedOutputs({ job }: { job: JobSummary }): React.JSX.Element | null {
  const { t } = useLanguage()

  const featured = job.featured_files ?? []
  const left = job.left_on_remote ?? []
  const featuredCount = job.featured_file_count ?? featured.length
  const leftCount = job.left_on_remote_count ?? left.length

  // No harvest data at all — a job that has not finished, or one whose result carried nothing: the panel
  // stays out rather than standing there with empty headings.
  if (featured.length === 0 && left.length === 0 && !job.harvest_error) return null

  const notListed = Math.max(leftCount - left.length, 0)

  return (
    <section
      data-testid="featured-outputs"
      aria-label={t('jobDetail.featuredOutputs')}
      className="shrink-0 border-b border-border bg-muted/20 px-4 py-2.5 text-[12px]"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
        <span className="font-medium">{t('jobDetail.featuredOutputs')}</span>
        {featuredCount > 0 ? (
          <span data-testid="featured-output-count" className="text-muted-foreground">
            {t('jobDetail.featuredFilesLabel', { count: featuredCount })}
          </span>
        ) : null}
        {leftCount > 0 ? (
          <span data-testid="left-on-remote-count" className="text-warning-900">
            {t('jobDetail.leftOnRemote', { count: leftCount })}
          </span>
        ) : null}
        {job.harvest_error ? (
          <span data-testid="harvest-failed" className="text-destructive">
            {t('jobDetail.harvestFailed')}
          </span>
        ) : null}
      </div>

      {featured.length > 0 ? (
        <ul data-testid="featured-output-files" className="mt-1 space-y-0.5">
          {featured.map((file) => (
            <li key={file} className="break-all font-mono text-foreground">
              {file}
            </li>
          ))}
        </ul>
      ) : null}

      {left.length > 0 ? (
        <ul data-testid="left-on-remote-files" className="mt-1 space-y-0.5">
          {left.map((entry) => (
            <li key={entry.uri} className="break-all font-mono text-muted-foreground">
              {entry.uri}
              <span className="ml-2 font-sans">
                {entry.size_mb} MB · {entry.reason}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {notListed > 0 ? (
        <p data-testid="left-on-remote-not-listed" className="mt-1 text-warning-900">
          {t('jobDetail.leftOnRemoteNotListed', { count: notListed })}
        </p>
      ) : null}

      {job.harvest_error ? (
        <p data-testid="harvest-error" className="mt-1 break-all text-destructive">
          {job.harvest_error}
        </p>
      ) : null}

      {/* The workdir is the actionable half of a failed harvest: it is kept precisely so the files can be
          retrieved by hand, so it is shown next to the error and not instead of it. */}
      {job.harvest_error && job.remote_workdir ? (
        <p
          data-testid="harvest-error-workdir"
          className="mt-0.5 break-all font-mono text-muted-foreground"
        >
          {t('jobDetail.remoteWorkdir')}: {job.remote_workdir}
        </p>
      ) : null}
    </section>
  )
}
