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
//  - shell:          a local terminal command (bash/powershell) or the control-plane repl kernel.
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
  'remote-execution-has-no-local-protection'
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

// How the app treats a remote execution that cannot be isolated. The default is `confirm`: a
// remembered approval was granted without ever naming a protection level, so it cannot silently
// cover an unprotected run — the run asks explicitly and the answer is recorded. `remembered`
// restores the older silent behavior for users who accept it; `deny` refuses unprotected remote
// execution outright.
export const REMOTE_UNPROTECTED_EXECUTION_POLICIES = ['confirm', 'remembered', 'deny'] as const

export type RemoteUnprotectedExecutionPolicy =
  (typeof REMOTE_UNPROTECTED_EXECUTION_POLICIES)[number]

export const DEFAULT_REMOTE_UNPROTECTED_EXECUTION_POLICY: RemoteUnprotectedExecutionPolicy =
  'confirm'

export const isRemoteUnprotectedExecutionPolicy = (
  value: unknown
): value is RemoteUnprotectedExecutionPolicy =>
  typeof value === 'string' &&
  (REMOTE_UNPROTECTED_EXECUTION_POLICIES as readonly string[]).includes(value)

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
