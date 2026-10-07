// Execution protection level: the single, queryable answer to "how is this execution isolated when
// it runs?". It is deliberately narrower than "sandbox" — every level names something this build
// actually applies, and everything it does NOT apply is reported as a named gap next to it. The
// level is computed in the main process from live state (platform capability + the existing network
// egress allowlist) and travels two ways: it is queryable before a run (the protection matrix) and
// it is persisted with the run/job it describes (the evidence).
//
// LEVEL SEMANTICS ARE WEAKEST-LINK ON PURPOSE. A level is only raised when BOTH axes hold:
//   filesystem axis: the managed runtime is write-protected for the child process tree
//   network axis:    child-process egress goes through the allowlist proxy
// A surface with an OS write-guard but no egress filtering is NOT reported as sandboxed — it is
// reported as `unprotected` with the axis detail showing the write-guard still holds and the missing
// axis named. That is what makes "turn the allowlist off and the level drops" a true statement, and
// it is why the axes (`scope`) are always shipped alongside the level: the label never hides a
// protection that is still in force.

export const EXECUTION_SURFACES = ['notebook', 'shell', 'background-job', 'remote-host'] as const

// Where an execution physically happens, as the user meets it:
//  - notebook:       a local analysis cell (python/r), executed by the app-owned kernel process.
//  - shell:          a local terminal command (the platform's own shell) or the control-plane repl kernel.
//  - background-job: a job submitted to a compute host that keeps running after the turn (submit_job:
//                    detached SSH session or a scheduler submission).
//  - remote-host:    a command run on a compute host as part of the turn (call_command) or a
//                    session-cache download from it.
export type ExecutionSurface = (typeof EXECUTION_SURFACES)[number]

export const EXECUTION_PROTECTION_LEVELS = [
  'os-sandbox',
  'network-allowlist',
  'unprotected'
] as const

export type ExecutionProtectionLevel = (typeof EXECUTION_PROTECTION_LEVELS)[number]

// Ordered strongest first. `os-sandbox` therefore always outranks `network-allowlist`, and a
// downgrade is any change to a larger index.
const PROTECTION_LEVEL_RANK: Readonly<Record<ExecutionProtectionLevel, number>> = {
  'os-sandbox': 0,
  'network-allowlist': 1,
  unprotected: 2
}

export const executionProtectionRank = (level: ExecutionProtectionLevel): number =>
  PROTECTION_LEVEL_RANK[level]

export const compareExecutionProtection = (
  left: ExecutionProtectionLevel,
  right: ExecutionProtectionLevel
): number => executionProtectionRank(left) - executionProtectionRank(right)

// The two axes the level is derived from, always reported as they actually are.
export type ExecutionProtectionScope = {
  filesystem: 'runtime-write-protected' | 'unrestricted'
  network: 'allowlist' | 'unrestricted'
}

// One layer per mechanism this build can actually apply. `applied` lists the ones in force for this
// surface; a layer missing from `applied` is not a bug to be inferred from the level, it is a fact.
export const EXECUTION_PROTECTION_LAYERS = [
  'macos-seatbelt-runtime-write',
  'egress-allowlist',
  'managed-runtime-mutation-guard'
] as const

export type ExecutionProtectionLayerId = (typeof EXECUTION_PROTECTION_LAYERS)[number]

// Named reasons a surface is not at a higher level. Each code is stable so the UI can render a
// localized sentence and repair path, while `detail` stays evidence-readable in English.
export const EXECUTION_PROTECTION_UNMET_CODES = [
  // The allowlist master switch is off: child processes reach any destination they can resolve.
  'network-allowlist-disabled',
  // This platform has no OS write-guard for the child process tree in this build.
  'os-sandbox-unavailable-platform',
  // The platform has the mechanism but the binary/profile it needs is missing on this machine.
  'os-sandbox-component-missing',
  // Remote execution runs under the user's own account on the host, with no local protection
  // layer applicable at all. This is the honest state of every remote surface in this build.
  'remote-execution-has-no-local-protection',
  // The level could not be determined at all (the settings read backing it failed). Reported as its
  // own gap instead of being mistaken for a level that was measured and came out low.
  'protection-unresolved'
] as const

export type ExecutionProtectionUnmetCode = (typeof EXECUTION_PROTECTION_UNMET_CODES)[number]

// Actionable repair steps. `detail` is the English evidence sentence; the UI renders a localized
// instruction from `code`. A repair step is what separates this from a bare error message: every
// downgrade ships with something the user can actually do about it.
export const EXECUTION_PROTECTION_REPAIR_CODES = [
  'enable-network-allowlist',
  'run-locally',
  'platform-has-no-os-sandbox'
] as const

export type ExecutionProtectionRepairCode = (typeof EXECUTION_PROTECTION_REPAIR_CODES)[number]

const REPAIR_DETAILS: Readonly<Record<ExecutionProtectionRepairCode, string>> = {
  'enable-network-allowlist':
    'Turn on Settings → Network → "Restrict process network access" and keep the domain groups this run needs enabled.',
  'run-locally':
    'Run the work on this machine (notebook or terminal) instead of on a compute host when the protection level matters.',
  'platform-has-no-os-sandbox':
    'This build has no OS sandbox adapter for this platform; egress allowlisting is the only isolation available here.'
}

export type ExecutionProtectionUnmet = {
  code: ExecutionProtectionUnmetCode
  detail: string
}

export type ExecutionProtectionSnapshot = {
  surface: ExecutionSurface
  level: ExecutionProtectionLevel
  platform: string
  capturedAt: number
  scope: ExecutionProtectionScope
  applied: ExecutionProtectionLayerId[]
  unmet: ExecutionProtectionUnmet[]
  // Present only for remote surfaces: which host the snapshot describes.
  remote?: {
    providerId: string
    displayName: string
    executionMode: 'direct_ssh' | 'slurm'
  }
}

export type ExecutionProtectionInput = {
  surface: ExecutionSurface
  platform: string
  // The existing egress allowlist master switch (shared/egress `EgressSettings.enabled`). The
  // protection level never re-derives network policy: it reads the one mechanism that exists.
  networkAllowlistEnabled: boolean
  // True only when this platform HAS an OS write-guard for the child process tree AND the component
  // it needs is present on this machine. Callers pass the probe result; this module never probes.
  osWriteGuardAvailable: boolean
  remote?: {
    providerId: string
    displayName: string
    executionMode: 'direct_ssh' | 'slurm'
  }
  capturedAt?: number
}

const REMOTE_SURFACES: readonly ExecutionSurface[] = ['background-job', 'remote-host']

export const isRemoteExecutionSurface = (surface: ExecutionSurface): boolean =>
  REMOTE_SURFACES.includes(surface)

const unmet = (code: ExecutionProtectionUnmetCode, detail: string): ExecutionProtectionUnmet => ({
  code,
  detail
})

/**
 * Computes the protection level a surface will run at. Pure: every capability it needs is passed in,
 * so the matrix the user reads and the snapshot a run persists are computed by the same function
 * from the same inputs.
 *
 * Remote surfaces are always `unprotected`, and that is not a placeholder: a remote command runs
 * under the user's own account on the host, so neither the local OS write-guard nor the local
 * egress proxy applies to it. The local allowlist is not counted as remote protection — claiming it
 * would be exactly the kind of overstatement a protection matrix exists to prevent.
 */
export const resolveExecutionProtection = (
  input: ExecutionProtectionInput
): ExecutionProtectionSnapshot => {
  const capturedAt = input.capturedAt ?? Date.now()

  if (isRemoteExecutionSurface(input.surface)) {
    return {
      surface: input.surface,
      level: 'unprotected',
      platform: input.platform,
      capturedAt,
      scope: { filesystem: 'unrestricted', network: 'unrestricted' },
      applied: [],
      unmet: [
        unmet(
          'remote-execution-has-no-local-protection',
          input.surface === 'background-job'
            ? 'The job runs on the compute host under your account and keeps running after this turn; no local protection layer applies.'
            : 'The command runs on the compute host under your account; no local protection layer applies.'
        )
      ],
      ...(input.remote ? { remote: { ...input.remote } } : {})
    }
  }

  const filesystemProtected = input.platform === 'darwin' && input.osWriteGuardAvailable
  const networkFiltered = input.networkAllowlistEnabled

  const scope: ExecutionProtectionScope = {
    filesystem: filesystemProtected ? 'runtime-write-protected' : 'unrestricted',
    network: networkFiltered ? 'allowlist' : 'unrestricted'
  }

  const applied: ExecutionProtectionLayerId[] = ['managed-runtime-mutation-guard']
  if (filesystemProtected) applied.push('macos-seatbelt-runtime-write')
  if (networkFiltered) applied.push('egress-allowlist')

  const unmetReasons: ExecutionProtectionUnmet[] = []
  if (!networkFiltered) {
    unmetReasons.push(
      unmet(
        'network-allowlist-disabled',
        'Child-process egress is not filtered: the allowlist master switch is off, so any destination is reachable.'
      )
    )
  }
  if (!filesystemProtected) {
    unmetReasons.push(
      input.platform === 'darwin'
        ? unmet(
            'os-sandbox-component-missing',
            'The macOS write-guard component (/usr/bin/sandbox-exec) is not available, so the managed runtime is not write-protected for child processes.'
          )
        : unmet(
            'os-sandbox-unavailable-platform',
            `No OS write-guard is applied to child processes on ${input.platform} in this build.`
          )
    )
  }

  // Weakest-link: both axes must hold for the top level, so dropping either one lowers the level
  // and names the axis that dropped.
  const level: ExecutionProtectionLevel =
    filesystemProtected && networkFiltered
      ? 'os-sandbox'
      : networkFiltered
        ? 'network-allowlist'
        : 'unprotected'

  return {
    surface: input.surface,
    level,
    platform: input.platform,
    capturedAt,
    scope,
    applied,
    unmet: unmetReasons
  }
}

/**
 * A snapshot for the case where the level could not be determined at all. Level is the floor
 * (`unprotected`) and the reason is named, so a failed lookup is never confused with a measurement
 * that came out low — and never silently reported as protected.
 */
export const unresolvedExecutionProtectionSnapshot = (input: {
  surface: ExecutionSurface
  platform: string
  detail: string
  capturedAt?: number
}): ExecutionProtectionSnapshot => ({
  surface: input.surface,
  level: 'unprotected',
  platform: input.platform,
  capturedAt: input.capturedAt ?? Date.now(),
  scope: { filesystem: 'unrestricted', network: 'unrestricted' },
  applied: [],
  unmet: [unmet('protection-unresolved', input.detail)]
})

/** The repair steps for the gaps a snapshot reports, in a stable order. Empty when nothing is unmet. */
export const protectionRepairSteps = (
  snapshot: ExecutionProtectionSnapshot
): Array<{ code: ExecutionProtectionRepairCode; detail: string }> => {
  const codes: ExecutionProtectionRepairCode[] = []
  if (snapshot.unmet.some((reason) => reason.code === 'network-allowlist-disabled')) {
    codes.push('enable-network-allowlist')
  }
  if (
    snapshot.unmet.some(
      (reason) =>
        reason.code === 'os-sandbox-unavailable-platform' ||
        reason.code === 'os-sandbox-component-missing'
    )
  ) {
    // No local action can conjure an OS write-guard this build does not ship: saying so is the
    // repair step, and the allowlist step above stays the only lever the user actually has.
    codes.push('platform-has-no-os-sandbox')
  }
  if (snapshot.unmet.some((reason) => reason.code === 'remote-execution-has-no-local-protection')) {
    codes.push('run-locally')
  }
  return [...new Set(codes)].map((code) => ({ code, detail: REPAIR_DETAILS[code] }))
}

/**
 * A stable, machine-checkable one-liner for evidence: the same surface at the same level with the
 * same gaps produces the same string, so a run's protection can be compared and re-read later
 * without parsing prose. Ordering is fixed; unknown input cannot reorder it.
 */
export const protectionEvidenceLine = (snapshot: ExecutionProtectionSnapshot): string =>
  [
    `execution-protection:v1`,
    `surface=${snapshot.surface}`,
    `level=${snapshot.level}`,
    `platform=${snapshot.platform}`,
    `filesystem=${snapshot.scope.filesystem}`,
    `network=${snapshot.scope.network}`,
    `applied=${[...snapshot.applied].sort().join('+') || 'none'}`,
    `unmet=${[...snapshot.unmet.map((reason) => reason.code)].sort().join('+') || 'none'}`
  ].join(' ')

// ---------------------------------------------------------------------------
// Remote unprotected execution policy
// ---------------------------------------------------------------------------

// How the app treats a remote execution that cannot be isolated. The default is `deny`: a remote
// run has no isolation to fall back on, and an approval recorded before protection levels existed
// never named one, so it cannot silently authorize an unprotected run. `confirm` lets each such run
// ask explicitly and records the answer; `remembered` restores the older silent behavior for users
// who deliberately accept it. Relaxing the default is a decision the user makes, never a default
// they discover.
export const REMOTE_UNPROTECTED_EXECUTION_POLICIES = ['confirm', 'remembered', 'deny'] as const

export type RemoteUnprotectedExecutionPolicy =
  (typeof REMOTE_UNPROTECTED_EXECUTION_POLICIES)[number]

export const DEFAULT_REMOTE_UNPROTECTED_EXECUTION_POLICY: RemoteUnprotectedExecutionPolicy = 'deny'

// Where a user changes that policy, and the option labels, as they read in the panel. Single source:
// the refusal message below quotes them, and `protection-policy-labels.test.ts` pins the panel's
// English labels to these strings, so renaming an option in the dictionary fails a test instead of
// leaving a refusal that points at a setting nobody can find. The message itself stays English (this
// text travels to the agent as instructions, and agent-facing text is not localized).
export const REMOTE_UNPROTECTED_SETTING_PATH =
  'Settings → Execution protection → "Remote execution without protection"'

export const REMOTE_UNPROTECTED_POLICY_LABELS: Readonly<
  Record<RemoteUnprotectedExecutionPolicy, string>
> = {
  confirm: 'Ask every time',
  remembered: 'Let remembered approvals cover it',
  deny: 'Refuse unprotected remote execution'
}

/**
 * The refusal a caller gets when the policy — not a user's answer — is what stopped the run. It names
 * the policy, says plainly that no approval was requested, and points at the one setting that changes
 * the outcome, because a bare "denied" is what sends an operator hunting for a grant that would not
 * have helped: the policy is consulted before any grant or card.
 */
export const remoteUnprotectedRefusalMessage = (hostName: string): string =>
  `Remote execution on "${hostName}" was refused by the execution-protection policy ` +
  `("${REMOTE_UNPROTECTED_POLICY_LABELS.deny}" is in force): a remote run cannot be isolated by this ` +
  `machine, so nothing was submitted and no approval was requested. To allow it, open ` +
  `${REMOTE_UNPROTECTED_SETTING_PATH} and choose "${REMOTE_UNPROTECTED_POLICY_LABELS.confirm}" or ` +
  `"${REMOTE_UNPROTECTED_POLICY_LABELS.remembered}". Do not retry until the user changes that setting.`

export type ExecutionProtectionMatrix = {
  platform: string
  capturedAt: number
  osWriteGuard: OsWriteGuardStatus
  networkAllowlist: { enabled: boolean }
  // One row per execution surface. Remote rows carry no host block: the level of a remote execution
  // does not depend on which host it is, so per-host duplication would only invite the reader to
  // think some host is safer than another.
  surfaces: ExecutionProtectionSnapshot[]
  remoteUnprotectedPolicy: RemoteUnprotectedExecutionPolicy
}

// The OS write-guard this build can apply to local child processes, and whether this machine has the
// component it needs. Reported next to the level so "why isn't this sandboxed" is answerable.
export type OsWriteGuardStatus = {
  platform: string
  component: string
  componentPresent: boolean
  // True only for a platform whose spawn paths apply the guard AND whose component is present.
  available: boolean
}

export type RemoteExecutionTarget = {
  providerId: string
  displayName: string
  executionMode: 'direct_ssh' | 'slurm'
}

// Read/write surface for the protection matrix. One channel with two actions rather than two
// channels: the setter is the same settings block the getter reports, and every write returns the
// freshly resolved matrix so the panel never renders a stale level after a change.
export const EXECUTION_PROTECTION_COMMAND_CHANNEL = 'settings:execution-protection'

export type ExecutionProtectionCommandRequest =
  { action: 'matrix' } | { action: 'set-remote-policy'; policy: RemoteUnprotectedExecutionPolicy }

export type ExecutionProtectionCommandResult = {
  matrix: ExecutionProtectionMatrix
}

export const isRemoteUnprotectedExecutionPolicy = (
  value: unknown
): value is RemoteUnprotectedExecutionPolicy =>
  typeof value === 'string' &&
  (REMOTE_UNPROTECTED_EXECUTION_POLICIES as readonly string[]).includes(value)

// Persisted execution-protection preferences. Kept as its own settings block rather than folded into
// the egress allowlist: the allowlist decides what the network may reach, this decides what the app
// is willing to run unprotected.
export type ExecutionProtectionSettings = {
  remoteUnprotectedPolicy: RemoteUnprotectedExecutionPolicy
}

export const DEFAULT_EXECUTION_PROTECTION_SETTINGS: ExecutionProtectionSettings = {
  remoteUnprotectedPolicy: DEFAULT_REMOTE_UNPROTECTED_EXECUTION_POLICY
}

/**
 * Whether a remembered (session/project/global) approval may cover this request without asking
 * again. Unprotected executions are the case that must not be covered silently under the default
 * policy; `deny` never allows them at all.
 */
export const rememberedApprovalCoversUnprotected = (
  policy: RemoteUnprotectedExecutionPolicy
): boolean => policy === 'remembered'

/** Whether the policy refuses the run outright (no approval card can rescue it). */
export const policyDeniesUnprotectedExecution = (
  policy: RemoteUnprotectedExecutionPolicy,
  level: ExecutionProtectionLevel
): boolean => policy === 'deny' && level === 'unprotected'
