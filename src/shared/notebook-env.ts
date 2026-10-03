import type { NotebookLanguage } from './notebook'

// Canonical wire shapes for the notebook runtime provisioning surface (contract §4). Renderer,
// preload, and the main provisioner (Plan A) all import these so there is one source of truth.
export type ProvisionScope = 'python' | 'r'
export type ProvisionOperationScope = ProvisionScope | 'upgrade'
export type ProvisionProgress = {
  phase: string
  message: string
  progress: number
  // Correlates renderer-requested provision/repair progress with the originating IPC call. Automatic
  // maintenance omits it so its terminal event cannot accidentally settle a queued explicit request.
  operationId?: string
  // Explicit at process boundaries so an automatic R provision is not inferred as a global upgrade.
  scope?: ProvisionOperationScope
  // Present for a provision triggered by one notebook run; other sessions remain visible and usable.
  sessionId?: string
  // `language` attributes an event to the env it concerns so the Settings UI can show python and R
  // provisioning independently — the provisioner serializes the two runs, but neither card should look
  // cancelled when the other is requested (undefined for language-agnostic events: upgrade/restore).
  language?: NotebookLanguage
  // Present during the pack-download phase so the UI can show speed/ETA/resume detail alongside the
  // coarse `progress` fraction.
  download?: import('./download-progress').DownloadProgress
}
export type RuntimeBundleSource = {
  kind: 'official' | 'override'
  baseUrl: string
}
export type ProvisionStatus = {
  pythonReady: boolean
  rReady: boolean
  version: number
  provisioning: boolean
  bundleSource?: RuntimeBundleSource
  // True when crash-recovery quarantined the language's app-managed default prefix (an interrupted
  // worker couldn't be confirmed stopped). The env may still read as ready, so the UI needs this
  // explicit signal to surface the Reset affordance instead of a normal, healthy-looking card.
  pythonRecoveryBlocked?: boolean
  rRecoveryBlocked?: boolean
}

// One named environment as surfaced by manage_environments(action:"list") and the UI's env selector.
export type EnvironmentInfo = {
  name: string
  language: NotebookLanguage
  ready: boolean
  isDefault: boolean
  sizeBytes?: number
  // The env's interpreter, so the window can promote it through the EXISTING selection channels
  // (register → enable → select) instead of needing a new backend surface. Absent for envs scanned off
  // a prefix whose interpreter is missing.
  interpreterPath?: string
}

// manage_environments tool request — discriminated on action (design D2).
export type ManageEnvironmentsRequest =
  | { action: 'create'; language: NotebookLanguage; name: string; packages?: string[] }
  | { action: 'list' }
  | { action: 'remove'; name: string }

// create/list/remove all return the full current env set so the caller/UI can refresh in one shot.
export type ManageEnvironmentsResult = { environments: EnvironmentInfo[] }

// Renderer-facing named-environment management (A7 follow-up, entry-layer audit P0-8). Deliberately
// NARROWER than the agent's ManageEnvironmentsRequest: the window may list and remove a named env, but
// never create one behind the agent's own binding flow.
export type NamedEnvironmentRequest = { action: 'list' } | { action: 'remove'; name: string }

// Same shape as the agent's result so both callers read the refreshed set from one place.
export type NamedEnvironmentResult = ManageEnvironmentsResult

// A7 external-lock import (renderer channel `runtime:import-lock`). The user supplies a raw @EXPLICIT
// lock; every entry must carry a 32-hex md5 or the whole lock is refused.
export type ImportLockRequest = {
  language: NotebookLanguage
  name: string
  /** Raw lock text: one `https://…/pkg.tar.bz2#<md5>` per line (a leading `@EXPLICIT` line is fine). */
  lock: string
  /** When false, a tarball missing from the shared cache is a named failure instead of a download. */
  allowDownload: boolean
}

// Per-entry coverage of one import. `missing` is NAMED and non-empty means nothing was created.
export type ImportLockCoverage = {
  total: number
  fromCache: number
  downloaded: number
  missing: Array<{ file: string; reason: string }>
}

// Discriminated so the window can render the per-entry failure list without parsing an error string.
// `imported` means the environment prefix exists and its interpreter verified; `incomplete` means NO
// prefix was created and `coverage.missing` explains every entry that could not be satisfied.
export type ImportLockResult =
  | { status: 'imported'; environment: EnvironmentInfo; coverage: ImportLockCoverage }
  | { status: 'incomplete'; coverage: ImportLockCoverage }
