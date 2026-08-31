import type { ClaudeInstallProgressEvent } from '../../../../shared/settings'

const mb = (bytes: number): string => (bytes / (1024 * 1024)).toFixed(1)

type InstallLabelKey =
  'common.resolving' | 'common.downloading' | 'common.extracting' | 'common.installing'
type Translate = (key: InstallLabelKey) => string

// Maps one progress tick to a human label and (when determinate) a 0..1 fill fraction. A missing
// fraction marks an indeterminate phase (npm/official, or an unknown download size). Pure so it can be
// unit-tested and shared without pulling in the framework-card component; the renderer passes `t`
// for localized labels and the fallback keeps English when no translator is supplied.
export const describeInstallProgress = (
  progress: ClaudeInstallProgressEvent,
  t?: Translate
): { label: string; fraction?: number } => {
  const label = (key: InstallLabelKey, fallback: string): string => (t ? t(key) : fallback)
  switch (progress.phase) {
    case 'resolving':
      return { label: label('common.resolving', 'Resolving…') }
    case 'downloading':
      if (progress.totalBytes && progress.receivedBytes != null) {
        return {
          label: `${label('common.downloading', 'Downloading')} — ${mb(progress.receivedBytes)} / ${mb(progress.totalBytes)} MB`,
          fraction: progress.receivedBytes / progress.totalBytes
        }
      }
      return { label: label('common.downloading', 'Downloading…') }
    case 'extracting':
      return { label: label('common.extracting', 'Extracting…') }
    case 'installing':
      return { label: label('common.installing', 'Installing…') }
  }
}
