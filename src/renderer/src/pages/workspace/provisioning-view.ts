import type { DownloadProgress } from '../../../../shared/download-progress'
import type {
  ProvisionOperationScope,
  ProvisionProgress,
  ProvisionScope,
  ProvisionStatus
} from '../../../../shared/notebook-env'

// Preparing scope can arrive explicitly on progress events. Older main-process senders omit it, so
// the reducer retains the legacy `(provisioning && pythonReady)` upgrade inference as a fallback.
type PreparingScope = ProvisionOperationScope

// Derived UI state for the single reusable provisioning surface (onboarding step, launch banner,
// notebook gate all render from this).
export type ProvisionUiState =
  | { kind: 'ready' }
  | {
      kind: 'preparing'
      scope: PreparingScope
      phase: string
      message: string
      progress: number
      sessionId?: string
      download?: DownloadProgress
    }
  | { kind: 'error'; message: string; scope?: PreparingScope; sessionId?: string }

// Pure mapping from the mirrored main-process state to the UI state. `scope` is the renderer's last
// explicit provision request (undefined for an auto upgrade); `error` is the last failed attempt.
export function deriveProvisionUi(
  status: ProvisionStatus,
  scope: ProvisionScope | undefined,
  progress: ProvisionProgress | undefined,
  error: string | undefined
): ProvisionUiState {
  // A progress tick is itself evidence that a run is in flight. The store deliberately does NOT re-read
  // the authoritative status on every tick (that write storm overflowed React's update depth — error
  // #185), so `status.provisioning` stays stale-false for the whole run. A derivation that trusted only
  // that flag would never reach the preparing state in a real window — and the Cancel button lives
  // exactly here, which would leave the gate un-escapable (measured: the main process reported
  // `provisioning: true` for two minutes while the notebook gate rendered nothing at all).
  const inFlight =
    status.provisioning ||
    (progress !== undefined && progress.phase !== 'done' && progress.phase !== 'error')
  if (inFlight) {
    const resolvedScope: PreparingScope =
      progress?.scope ?? scope ?? (status.pythonReady ? 'upgrade' : 'python')
    return {
      kind: 'preparing',
      scope: resolvedScope,
      phase: progress?.phase ?? '',
      message: progress?.message ?? '',
      progress: progress?.progress ?? 0,
      ...(progress?.sessionId ? { sessionId: progress.sessionId } : {}),
      ...(progress?.download ? { download: progress.download } : {})
    }
  }
  // A failed attempt only counts as a blocking error while python itself is missing; an R failure
  // leaves Python usable, so it does not surface as an app-level error.
  if (error && !status.pythonReady) {
    const failedProgress = progress?.phase === 'error' ? progress : undefined
    return {
      kind: 'error',
      message: error,
      ...(failedProgress?.scope ? { scope: failedProgress.scope } : {}),
      ...(failedProgress?.sessionId ? { sessionId: failedProgress.sessionId } : {})
    }
  }
  return { kind: 'ready' }
}

// The notebook pane is greyed while python is unavailable or while an additive upgrade is running.
// An R-only preparation never gates the pane — Python stays interactive (spec §6.5).
export function notebookGated(
  status: ProvisionStatus,
  ui: ProvisionUiState,
  sessionId?: string
): boolean {
  if (ui.kind !== 'ready' && ui.sessionId && sessionId && ui.sessionId !== sessionId) {
    return false
  }
  if (!status.pythonReady) return true
  return ui.kind === 'preparing' && ui.scope === 'upgrade'
}
