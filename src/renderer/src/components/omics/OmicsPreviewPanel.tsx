import { useMemo, useState } from 'react'
import { AlertTriangle, CheckCircle2, Cpu, PlayCircle } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  canAnswerFromPreview,
  describeOmicsScope,
  summarizeOmicsPreview,
  type OmicsPreviewManifest
} from '../../../../shared/omics-preview'
import {
  proposeOmicsFullRun,
  type OmicsFullRunOptions,
  type OmicsFullRunProposal
} from '../../../../shared/omics-full-run'
import { useLanguage } from '@/i18n'
import { asOmicsTranslate } from './omics-translate'

// Read-only view of a large-file preview plus the full-run entry point. Thin by design: every
// number, label and gate comes from shared/omics-preview and shared/omics-full-run, so the panel
// cannot present a subset as an answer or start work without an explicit choice (G1/G6/G2).
export type OmicsPreviewPanelProps = {
  manifest: OmicsPreviewManifest
  /** Registered compute hosts the user may pick from (empty ⇒ explain what is missing). */
  hosts?: { name: string; executionMode?: 'direct_ssh' | 'slurm' }[]
  /** Engine the analysis needs; shown in the proposal. */
  engine?: string
  /** Called when the user submits the approved full-run proposal. */
  onSubmitFullRun?: (proposal: OmicsFullRunProposal) => void
  className?: string
}

export function OmicsPreviewPanel({
  manifest,
  hosts = [],
  engine,
  onSubmitFullRun,
  className
}: OmicsPreviewPanelProps): React.JSX.Element {
  const { t } = useLanguage()
  const omicsT = asOmicsTranslate(t)
  const [hostName, setHostName] = useState<string>('')

  const scopeLabel = describeOmicsScope(manifest, omicsT)
  const summary = summarizeOmicsPreview(manifest, omicsT)
  const answerable = canAnswerFromPreview(manifest)

  const proposal = useMemo(() => {
    if (answerable) return null
    const host = hosts.find((entry) => entry.name === hostName)
    const options: OmicsFullRunOptions = {
      hostName: host?.name,
      executionMode: host?.executionMode,
      engine
    }
    return proposeOmicsFullRun(manifest, options, omicsT)
  }, [answerable, engine, hostName, hosts, manifest, omicsT])

  return (
    <div
      className={`flex flex-col gap-3 rounded-lg border border-[var(--border)] p-3 ${className ?? ''}`}
    >
      <div className="flex items-center gap-2 text-sm font-medium text-[var(--foreground)]">
        {answerable ? (
          <CheckCircle2 className="size-4 text-emerald-400" aria-hidden="true" />
        ) : (
          <AlertTriangle className="size-4 text-amber-400" aria-hidden="true" />
        )}
        <span data-testid="omics-scope-label">{scopeLabel}</span>
        <span className="text-xs text-[var(--muted-foreground)]" data-testid="omics-shape-summary">
          {summary}
        </span>
      </div>

      {!answerable ? (
        <p className="text-xs text-amber-400" data-testid="omics-provisional-warning">
          {t('omics.provisionalWarning')}
        </p>
      ) : null}

      {manifest.notes.length > 0 ? (
        <ul className="list-disc pl-4 text-xs text-[var(--muted-foreground)]">
          {manifest.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : null}

      {proposal ? (
        <div className="flex flex-col gap-2 rounded-md border border-[var(--border)] p-2">
          <div className="flex items-center gap-2 text-xs text-[var(--foreground)]">
            <Cpu className="size-3.5" aria-hidden="true" /> {t('omics.fullRunProposal')}
          </div>

          <label className="flex items-center gap-2 text-xs">
            <span className="text-[var(--muted-foreground)]">{t('omics.computeHost')}</span>
            <select
              aria-label={t('omics.computeHost')}
              data-testid="omics-host-select"
              value={hostName}
              onChange={(event) => setHostName(event.target.value)}
              className="rounded-md border border-[var(--border)] bg-transparent px-2 py-1"
            >
              <option value="">{t('omics.selectHost')}</option>
              {hosts.map((host) => (
                <option key={host.name} value={host.name}>
                  {host.name}
                  {host.executionMode === 'slurm' ? '（Slurm）' : ''}
                </option>
              ))}
            </select>
          </label>

          <p
            className="text-xs text-[var(--muted-foreground)]"
            data-testid="omics-proposal-deliverable"
          >
            {proposal.deliverable}
          </p>
          <p className="text-xs text-[var(--muted-foreground)]" data-testid="omics-proposal-reason">
            {proposal.reason}
          </p>

          {proposal.missing.length > 0 ? (
            <p className="text-xs text-amber-400" data-testid="omics-proposal-missing">
              {t('omics.missingLabel')} {proposal.missing.join('; ')}
            </p>
          ) : null}

          <p className="text-xs text-[var(--muted-foreground)]">
            {t('omics.labelsLabel')} {proposal.requiredResultLabels.join('; ')}
          </p>

          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              data-testid="omics-submit-full-run"
              disabled={!hostName || proposal.missing.length > 0}
              onClick={() => onSubmitFullRun?.(proposal)}
            >
              <PlayCircle className="size-3.5" aria-hidden="true" /> {t('omics.submitFullRun')}
            </Button>
            {!hostName ? (
              <span className="text-xs text-[var(--muted-foreground)]">
                {t('omics.selectHostFirst')}
              </span>
            ) : null}
          </div>
        </div>
      ) : (
        <p className="text-xs text-emerald-400" data-testid="omics-answerable">
          {t('omics.answerable')}
        </p>
      )}
    </div>
  )
}
