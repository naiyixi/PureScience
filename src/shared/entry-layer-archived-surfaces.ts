// A guard, not documentation: every renderer surface the desktop app installs must be reachable from
// the window, or carry an explicit archival decision here. The audit that produced this rule is
// `docs/evidence/2026-09-23-entry-layer-coverage-audit.md`; the register below records the decisions
// that closed it (the batch 0-4 follow-ups, plus the two surfaces this guard itself surfaced).
//
// Adding a surface to the contract catalog without a call site now fails
// `renderer-contract-entry-coverage.test.ts`. Fix it by wiring the surface, or by adding an entry here
// with the reason it stays agent/兼容-only — or with the unit that will build it.
export type EntryLayerArchivedSurface = {
  // The contract's public path, exactly as it appears in `renderer-contract-catalog.ts`.
  publicPath: string
  // Why the window never calls it. Keep this a decision, not a restatement of the name.
  reason: string
  // Where the decision is recorded (audit section, plan unit, or the code that supersedes it).
  evidence: string
}

const ARCHIVED: EntryLayerArchivedSurface[] = [
  {
    publicPath: 'acp.onEvent',
    reason:
      'Legacy push channel: the window reads session state snapshots instead, and nothing consumes the broadcast.',
    evidence: 'audit 批次 4 归档结论（U24）；renderer 0 命中'
  },
  {
    publicPath: 'acp.onPermissionRequest',
    reason:
      'Superseded by permission-grants-store (permissions.list/revoke) plus the waiting-permission session status.',
    evidence: 'audit 批次 4 归档结论（U24）；permission-grants-store.ts'
  },
  {
    publicPath: 'compute.enabledHostsGet',
    reason:
      'P2 readback of enabled hosts; the compute panel operates from compute.list plus the job/approval events.',
    evidence: 'audit 批次 4 归档结论（U23）；ComputePanel.tsx / stores/compute-store.ts'
  },
  {
    publicPath: 'compute.jobsMarkConsumed',
    reason:
      'Job-consumed marking stays on the agent side; the panel reflects job state from compute job updates.',
    evidence: 'audit 批次 4 归档结论（U23）；App.tsx:458,464'
  },
  {
    publicPath: 'compute.jobsPendingNotification',
    reason:
      'Pending-notification readback stays on the agent side; notifications reach the window through the notifications surface.',
    evidence: 'audit 批次 4 归档结论（U23）'
  },
  {
    publicPath: 'notebook.appendCodeCell',
    reason:
      'Streaming half of the agent write protocol (begin/append/finish); the window observes cells through notebook:state instead of writing them.',
    evidence: 'plan U21；main/notebook/ipc.ts:24-35'
  },
  {
    publicPath: 'notebook.beginCodeCell',
    reason:
      'Opens the agent write lock; a window-side writer would race the agent stream the pane renders.',
    evidence: 'plan U21；main/notebook/ipc.ts:24-35'
  },
  {
    publicPath: 'notebook.finishCodeCell',
    reason:
      'Releases the agent write lock; paired with begin/append, which the window deliberately does not drive.',
    evidence: 'plan U21；main/notebook/ipc.ts:24-35'
  },
  {
    publicPath: 'settings.getPackageMirror',
    reason: 'The mirror arrives with the settings snapshot instead of a dedicated read.',
    evidence: 'audit 批次 4 归档结论（U23）；stores/settings-store.ts:113/173/193'
  },
  {
    publicPath: 'settings.xaiOauthRefresh',
    reason:
      'Agent-facing application command (host-application-commands) that keeps an OAuth session fresh; the user path is start/complete.',
    evidence: 'audit 批次 4 归档结论（U23）；main/settings/application-commands.ts:403-411'
  },
  {
    publicPath: 'settings.xaiOauthStatus',
    reason:
      'Companion readback to xai-oauth-refresh, agent-facing; the providers panel reads the outcome through start/complete.',
    evidence: 'audit 批次 4 归档结论（U23）；main/settings/application-commands.ts:408-411'
  },
  {
    publicPath: 'handoff.onChanged',
    reason:
      'The lifecycle face is declared in the contract and exposed by preload but never installed in main (plan U22/U29), so the window cannot subscribe to it. Its list/retry siblings slip past the tolerant matcher because the legacy client speaks of listeners and retryHandoff.',
    evidence: 'plan U22 结论修正；src/main/agents/handoff-lifecycle-ipc.ts:25 无调用点'
  },
  {
    publicPath: 'specialist.cancelHandoff',
    reason:
      'No window intent: failure retry/continuation is carried by the production face (specialist:retry-handoff, installed at main/ipc.ts:910).',
    evidence: 'plan U22 结论修正；audit 批次 4 归档结论（U23）'
  },
  {
    publicPath: 'storage.validateDataRoot',
    reason:
      'Host/agent command; the data-root setting flow validates inside its own save path, so no user-triggered check is needed.',
    evidence: 'audit 批次 4 归档结论（U23）；host-application-commands.ts:284'
  },
]

export const ENTRY_LAYER_ARCHIVED_SURFACES: readonly EntryLayerArchivedSurface[] =
  Object.freeze(ARCHIVED)

// Registrars that install IPC handlers nothing installs at boot. Kept here (not silently deleted) so the
// decision is visible and the main-installation guard can demand that an entry leave once it is wired.
export type MainInstallationPendingEntry = {
  name: string
  file: string
  reason: string
  evidence: string
}

export const MAIN_INSTALLATION_PENDING: MainInstallationPendingEntry[] = [
  {
    name: 'registerHandoffLifecycleIpcHandlers',
    file: 'agents/handoff-lifecycle-ipc.ts',
    reason:
      'PENDING BUILD (U29): a parallel lifecycle implementation whose IPC was never installed — the production gate runs CompletionHandoffLifecycle (main/ipc.ts:899-910). U22 migrated the window onto this face, which reddened 16 packaged certification specs with "No handler registered", and had to be reverted. U29 wires this face onto the production lifecycle via a thin transport adapter.',
    evidence: 'audit 批次 4（U22 复盘）；plan U29 方案'
  }
]
