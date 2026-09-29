import type { UpdateStatus } from '../../shared/update'

// How a single backend teardown ended. Structurally identical to lifecycle-shutdown's
// ShutdownStepOutcome so the coordinator's outcome satisfies this without coupling update code to that
// module (same trick as InstallReadiness itself).
export type InstallGateStep = 'completed' | 'timeout' | 'failed' | 'degraded'

// Readiness reported by the pre-install gate: whether the backend teardown completed within its budget
// and whether every process tree was cleanly reaped. `steps` names each backend's own outcome so a
// refusal can say which teardown was incomplete instead of only that "something" was.
export type InstallReadiness = {
  completed: boolean
  reaped: boolean
  steps?: { runtime: InstallGateStep; notebook: InstallGateStep }
}

// Runs backend teardown before an in-place install and reports whether it is safe to proceed. The
// in-place strategy receives it at construction and awaits it before quitAndInstall, so the installer
// never starts while a background process still holds app files open.
export type InstallGate = () => Promise<InstallReadiness>

export const INSTALL_GATE_BACKENDS = ['runtime', 'notebook'] as const
export type InstallGateBackend = (typeof INSTALL_GATE_BACKENDS)[number]

const BACKEND_LABELS: Record<InstallGateBackend, string> = {
  runtime: 'the agent runtime',
  notebook: 'the notebook kernels'
}

const listBackends = (backends: InstallGateBackend[]): string => {
  if (backends.length === 0) return ''
  if (backends.length === 1) return BACKEND_LABELS[backends[0]]
  return `${BACKEND_LABELS[backends[0]]} and ${BACKEND_LABELS[backends[1]]}`
}

export type InstallGateRefusal = {
  // The machine-readable cause, recorded in diagnostics.
  reason: 'install-gate-timeout' | 'install-gate-degraded'
  // The user-facing sentence shown in the dialog. Built from structural facts only — never the
  // teardown's own error text, which can carry local paths (the privacy rule the diagnostics follow).
  message: string
}

// A refused handoff must never look like nothing happened: the user gets the cause (the teardown did not
// finish in budget vs. it finished with process trees still alive) AND which backend teardown it was.
export const describeInstallGateRefusal = (readiness: InstallReadiness): InstallGateRefusal => {
  const steps = readiness.steps
  const incomplete = steps
    ? INSTALL_GATE_BACKENDS.filter((backend) => steps[backend] !== 'completed')
    : []
  const named = listBackends(incomplete)
  if (!readiness.completed) {
    return {
      reason: 'install-gate-timeout',
      message: named
        ? `Background processes did not stop in time (${named}), so the update was not installed. Close running tasks. Please try again.`
        : 'Background processes did not stop in time, so the update was not installed. Close running tasks. Please try again.'
    }
  }
  return {
    reason: 'install-gate-degraded',
    message: named
      ? `Background processes could not be fully stopped (${named}), so the update was not installed. Please try again.`
      : 'Background processes could not be fully stopped, so the update was not installed. Please try again.'
  }
}

// The platform-agnostic update contract the IPC layer and scheduler drive. Two implementations exist:
// ElectronUpdaterStrategy (win/linux, and signed stable macOS — in-place download/restart) and
// UpdateService (dev/nightly macOS + any other fallback — manifest download + manual reinstall). Both
// broadcast the same UpdateStatus. See create-strategy.ts for how the host is routed.
export interface UpdateStrategy {
  getStatus(): UpdateStatus
  check(): Promise<UpdateStatus>
  download(): Promise<UpdateStatus>
  // Aborts an in-flight download, stops network activity, and returns the reset status (back to
  // 'available' when a download was running). A no-op when nothing is downloading.
  cancel(): Promise<UpdateStatus>
  // Applies a ready update: open the installer (mac) or quitAndInstall (win/linux).
  apply(): Promise<UpdateStatus>
}
