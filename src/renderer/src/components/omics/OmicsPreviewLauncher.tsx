import { useLanguage } from '@/i18n'
import { useState } from 'react'
import { FileJson, Upload } from 'lucide-react'

import { isOmicsPreviewManifest, type OmicsPreviewManifest } from '../../../../shared/omics-preview'
import type { OmicsFullRunProposal } from '../../../../shared/omics-full-run'
import { OmicsPreviewPanel } from './OmicsPreviewPanel'

// Launcher for the large-file preview: it never invents a manifest. The manifest comes from running
// the omics-data-preview skill (which reads the file read-only and downsamples honestly), so this
// component either loads that document or explains how to produce it.
export type OmicsPreviewLauncherProps = {
  /** Name of the large file the user asked about (shown in the guidance). */
  sourceName: string
  hosts?: { name: string; executionMode?: 'direct_ssh' | 'slurm' }[]
  engine?: string
  onSubmitFullRun?: (proposal: OmicsFullRunProposal) => void
  /** Dismiss the launcher overlay. */
  onClose?: () => void
  className?: string
}

export function OmicsPreviewLauncher({
  sourceName,
  hosts,
  engine,
  onSubmitFullRun,
  onClose,
  className
}: OmicsPreviewLauncherProps): React.JSX.Element {
  const { t } = useLanguage()
  const [manifest, setManifest] = useState<OmicsPreviewManifest | null>(null)
  const [error, setError] = useState<string | undefined>(undefined)

  const handleFile = async (file: File | undefined): Promise<void> => {
    if (!file) return
    try {
      const parsed: unknown = JSON.parse(await file.text())
      if (!isOmicsPreviewManifest(parsed)) {
        setError(t('omics.invalidManifest'))
        setManifest(null)
        return
      }
      setManifest(parsed)
      setError(undefined)
    } catch (cause) {
      setError(
        t('omics.manifestReadFailed').replace(
          '{message}',
          cause instanceof Error ? cause.message : String(cause)
        )
      )
      setManifest(null)
    }
  }

  if (manifest) {
    return (
      <div className={`flex flex-col gap-2 ${className ?? ''}`}>
        <div className="flex items-center justify-between text-xs text-[var(--muted-foreground)]">
          <span data-testid="omics-manifest-source">
            {t('omics.manifestLoaded').replace('{path}', manifest.path)}
          </span>
          <button
            type="button"
            className="underline"
            onClick={() => {
              setManifest(null)
              setError(undefined)
            }}
          >
            {t('omics.replaceManifest')}
          </button>
        </div>
        <OmicsPreviewPanel
          manifest={manifest}
          hosts={hosts}
          engine={engine}
          onSubmitFullRun={onSubmitFullRun}
        />
      </div>
    )
  }

  return (
    <div
      className={`flex flex-col gap-2 rounded-lg border border-[var(--border)] p-3 ${className ?? ''}`}
    >
      <div className="flex items-center gap-2 text-sm font-medium text-[var(--foreground)]">
        <FileJson className="size-4" aria-hidden="true" /> {t('omics.largeFilePreview')}
        {onClose ? (
          <button
            type="button"
            data-testid="omics-launcher-close"
            className="ml-auto text-xs text-[var(--muted-foreground)] underline"
            onClick={onClose}
          >
            {t('common.close')}
          </button>
        ) : null}
      </div>
      <p className="text-xs text-[var(--muted-foreground)]" data-testid="omics-launcher-guidance">
        {t('omics.noManifestPrefix').replace('{name}', sourceName)}
        <code>omics-data-preview</code>
        {t('omics.noManifestSuffix')}
      </p>
      <label className="flex items-center gap-2 text-xs">
        <Upload className="size-3.5" aria-hidden="true" />
        <span>{t('omics.loadManifest')}</span>
        <input
          type="file"
          accept=".json,application/json"
          data-testid="omics-manifest-input"
          onChange={(event) => {
            void handleFile(event.target.files?.[0])
          }}
        />
      </label>
      {error ? (
        <p role="alert" className="text-xs text-red-400" data-testid="omics-launcher-error">
          {error}
        </p>
      ) : null}
    </div>
  )
}
