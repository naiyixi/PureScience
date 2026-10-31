import { RENDERER_CONTRACT_CATALOG } from '../shared/renderer-contract-catalog'
import { createLogger } from './logger'
import {
  acpApplicationCommands,
  registerAcpCommands,
  type AcpApplicationCommandDependencies
} from './acp/application-commands'
import {
  createApplicationCommandRouter,
  type ApplicationCommand,
  type ApplicationCommandDiagnostic,
  type ApplicationCommandInstallation,
  type ApplicationInvocation
} from './application-command-router'
import {
  computeApplicationCommandGroup,
  registerComputeApplicationCommands,
  type ComputeApplicationCommandDependencies
} from './compute/application-commands'
import {
  dataContentApplicationCommandGroups,
  registerDataContentApplicationCommands,
  type DataContentApplicationCommandDependencies
} from './data-content-application-commands'
import {
  hostApplicationCommandGroups,
  registerHostApplicationCommands,
  type HostApplicationCommandDependencies
} from './host-application-commands'
import {
  installNotebookApplicationCommands,
  notebookApplicationCommands,
  type NotebookApplicationCommandDependencies
} from './notebook/application-commands'
import {
  installNotebookEnvironmentApplicationCommands,
  notebookEnvironmentApplicationCommands
} from './notebook/environment-application-commands'
import {
  registerRuntimeApplicationCommands,
  runtimeApplicationCommandGroup,
  type RuntimeApplicationCommandDependencies
} from './notebook/runtime-application-commands'
import {
  permissionGrantApplicationCommandGroup,
  registerPermissionGrantApplicationCommands
} from './permission-grants/application-commands'
import {
  referencesApplicationCommandGroup,
  registerReferencesApplicationCommands,
  type ReferencesApplicationCommandDependencies
} from './references/application-commands'
import {
  registerCoreSettingsApplicationCommands,
  settingsCoreApplicationCommandGroup,
  type CoreSettingsApplicationCommandDependencies
} from './settings/application-commands'
import {
  registerIntegrationSettingsApplicationCommands,
  settingsApprovalApplicationCommandGroup,
  settingsConnectorApplicationCommandGroup,
  settingsSkillApplicationCommandGroup,
  type IntegrationSettingsApplicationCommandDependencies
} from './settings/integration-application-commands'
import {
  registerRuntimeSettingsApplicationCommands,
  settingsRuntimeApplicationCommandGroup,
  type RuntimeSettingsApplicationCommandDependencies
} from './settings/runtime-application-commands'
import {
  registerSessionPackageApplicationCommands,
  sessionPackageApplicationCommandGroup,
  type SessionPackageApplicationCommandDependencies
} from './session-package/application-commands'
// F1: the external MCP surface's command whitelist is derived from its own tool table, so a tool cannot be
// declared against a command an outside client may not reach. Four reads and one write; the write is gated
// by `externalApproval` below, which parks it on the app's own approval card.
import { externalMcpCommandNames } from './external-mcp/surface'
import type { ExternalMcpRequestApproval } from './external-mcp/server'

type AnyApplicationCommand = ApplicationCommand<string, readonly unknown[], unknown>
type NotebookEnvironmentDependencies = Parameters<
  typeof installNotebookEnvironmentApplicationCommands
>[1]
type PermissionGrantDependencies = Parameters<typeof registerPermissionGrantApplicationCommands>[1]
type RemoteAccessOwner = HostApplicationCommandDependencies['remoteAccess']

type ApplicationCommandByNameDispatcher = Readonly<{
  invoke: (
    commandName: string,
    invocation: ApplicationInvocation<readonly unknown[]>
  ) => Promise<unknown>
  commandNames: () => readonly string[]
}>

type RemoteWebApplicationCommandDispatcher = ApplicationCommandByNameDispatcher &
  Readonly<{ rejectedCommandNames: () => readonly string[] }>

type ApplicationCommandCompositionDependencies = Readonly<{
  acp: AcpApplicationCommandDependencies
  notebook: NotebookApplicationCommandDependencies
  notebookEnvironment: NotebookEnvironmentDependencies
  notebookRuntime: RuntimeApplicationCommandDependencies
  settingsCore: CoreSettingsApplicationCommandDependencies
  settingsIntegration: IntegrationSettingsApplicationCommandDependencies
  settingsRuntime: RuntimeSettingsApplicationCommandDependencies
  compute: ComputeApplicationCommandDependencies
  permissionGrants: PermissionGrantDependencies
  references: ReferencesApplicationCommandDependencies
  dataContent: DataContentApplicationCommandDependencies
  sessionPackage: SessionPackageApplicationCommandDependencies
  host: Omit<HostApplicationCommandDependencies, 'remoteAccess'>
}>

type ApplicationCommandComposition = Readonly<{
  localWeb: ApplicationCommandByNameDispatcher
  remoteWeb: RemoteWebApplicationCommandDispatcher
  task: ApplicationCommandByNameDispatcher
  /** The narrow view an outside MCP client reaches (`purescience mcp`). Four reads, one gated write. */
  externalMcp: ApplicationCommandByNameDispatcher
  /**
   * Parks an outside client's write on the app's own approval card — the same broker the agent's tool
   * calls use, so there is one consent surface and one `permission decision` line. The external MCP server
   * is started from a place that holds no ACP runtime, so the port is exported here rather than wired
   * there; a second route into the broker from that file would be a second consent mechanism.
   */
  externalApproval: ExternalMcpRequestApproval
  bindRemoteAccess: (owner: RemoteAccessOwner) => void
  dispose: () => void
}>

const GROUP_COUNT = 41
// +1 group: the PDF annotation group (pdf-annotations:create / import / list / reattach / remove) sits
// beside the PDF reading surface it belongs to, and every one of its channels is local-only.
// +1 group: the saved-search-filter-set group (searchPins.list / remove / save) sits beside the bookmarks
// and is registered on the local Web view like theirs.
// Counts are certified at startup: a new command without a matching increment fails the boot rather
// than shipping an uncertified surface. +1 internal / +2 local Web / +1 remote Web / +1 remote rejection
// is compute:deliveries:list (available on both Web surfaces) plus settings:set-ui-language (local only).
// settings:set-connectors-enabled moved internal / local Web / remote Web / task by one each: it is a
// settings write reachable from the window, the command line and both Web surfaces, so it dispatches
// remotely rather than landing in the fail-closed rejection set.
// Two more than before the list/document split: sessions:list-catalog and sessions:read-document are
// web-surface channels, so the total and the local-Web count move together. Remote dispatch and the
// task surface are untouched because neither channel carries a remote flag. project-files:list-kinds
// moved internal / local Web / remote dispatch by one each (it carries no surface flag, like the
// per-project read it replaces).
// +8 each on internal, local Web and remote Web dispatch: the literature-screening surface
// (references.getScreening / listScreeningRuleRevisions / appendScreeningRuleRevision /
// startScreeningRun / cancelScreeningRun / setScreeningOverride / setScreeningOverrides /
// clearScreeningOverride) is reachable from the window and both Web surfaces. The fail-closed remote
// rejection count is untouched because none of them is a local-only channel.
// +5 each on internal, local Web and the remote rejections: the PDF annotation surface. Read, write,
// re-anchor and import are all local-only — a paired remote browser may not touch the reader's markup —
// so the remote dispatch count is untouched and the fail-closed set takes all five.
// +2 each on internal, local Web and the remote rejections: the two annotation export channels
// (pdfAnnotations.exportAnnotated / exportNotes). Each one writes a file on the reader's machine, so both
// are local-only like the five above: the remote dispatch count stays where it was, and the fail-closed
// set takes both.
// +1 each on internal, local Web and the remote rejections: settings:execution-protection (the
// protection matrix read + the remote-policy write share one channel). It is a local-only settings
// channel — a paired remote browser may neither read nor change this machine's protection policy —
// so the remote dispatch count is untouched and the fail-closed set takes it.
// +1 each on internal, local Web and the remote rejections, and nothing on the remote dispatch: the
// function-model channel (settings:function-models — reads the slots, writes them, resolves what a
// function will use, runs a detection, and reads the trail). A paired remote browser may not change which
// model answers this machine's own calls, so it is local-only like the protection channel above.
// +1 each on internal, local Web and the remote rejections, and nothing on the remote dispatch: the skill
// availability channel (settings:skill-availability). Deciding which skills a paired remote browser's agent
// may load is a change to this machine's install, so it is local-only as well.
// +1 each on internal, local Web and remote Web dispatch, and nothing on the fail-closed set: the journal
// metric import (references:import-journal-metrics) is reachable from the window like every other library
// write, so it carries no local-only flag.
// +1 each on internal, local Web and remote Web dispatch, and nothing on the fail-closed set: the journal
// merge (references:merge-journals) is a window action like the other library writes — a paired remote
// browser may also use it — so it carries no local-only flag and the dispatch count moves with it.
// +1 each on internal, local Web and the remote rejections, and nothing on the remote dispatch: the
// external-lock import (runtime:import-lock, A7). It writes THIS machine's runtime root, so a paired
// remote browser may not run it — local-only, counted with the fail-closed set. (The app's own startup
// certification caught this count when the channel was added: a missed bump refuses to start, which is
// the point of pinning it here rather than in a unit test alone.)
// +1 each on the same three for the named-environment surface (runtime:manage-named-environments,
// audit P0-8): listing and deleting this machine's named envs is equally local-only, so the dispatch
// count stays and the fail-closed set takes it.
// +1 each on internal, local Web and the remote rejections for the artifact reveal handoff
// (artifacts:reveal-file): showing a managed file in the file manager is local-only, like open-file, so it
// is refused on the remote surface and counted there.
// +1 each on the same three for the window package install/uninstall (runtime:manage-packages, IC13):
// writing THIS machine's runtime root from a Settings dialog is local-only by nature, so the dispatch
// count stays and the fail-closed set takes it.
// +1 each on internal, local Web and the remote rejections for stopping a remote job
// (compute:jobs:cancel, IC39): asking THIS machine to kill a job it launched is local-only by nature
// — a paired browser never gets to stop someone else's remote process — so the dispatch count stays
// and the fail-closed set takes it.
// +1 each on internal, local Web and the remote Web dispatch, and nothing on the fail-closed set: releasing
// an alias a merge created (references:remove-journal-alias) is the overwrite of a library row, exactly like
// the merge that wrote it — a window action reachable from the remote surface too, so the dispatch count
// moves with it.
// +1 each on internal, local Web and the remote Web dispatch, and nothing on the fail-closed set: the
// skill fork (settings:fork-imported-skill) duplicates an imported skill into this machine's own skill
// root exactly like the create / update / import channels beside it, so it carries no local-only flag
// and both Web surfaces move with it.
// +1 each on internal, local Web and the remote rejections for verifying a recorded reading
// (artifacts:verify-reading): asking THIS machine to repeat a request it recorded is local-only by
// nature — a paired browser does not get to make this host egress — so the dispatch count stays and the
// fail-closed set takes it.
// +1 internal and +1 local Web for the goals panel's read-only channel (goal:list-all, LOCAL), and
// +1 on the remote rejections: a reader with no session context still only ever reads, and a paired
// browser has no business enumerating what this machine's sessions are pursuing.
// +2 each on internal and local Web, and +2 on the remote rejections, for the local parsing models
// (settings:get-local-parsing-models / settings:download-local-parsing-model, LOCAL): which models are
// present on THIS machine, and pulling one onto it, are local-only by nature — a paired browser does not
// get to enumerate or fetch this host's model assets — so the remote dispatch count stays where it is.
// 368 with the citation mark (v2.6.0 A2: references:mark-cited / references:clear-cited), registered
// in the references group beside the notes write.
// 369 with the session run-data measurement (sessions:read-notebook-usage): a plain Web request channel,
// so it counts on every surface that dispatches (below) and not in the fail-closed set.
// 371 with the DOI integrity pair (references:check-integrity / references:read-integrity-summary): the
// explicit check egresses and rewrites stored verdicts, and the summary is the reader the export gate
// consults. Neither is registered on the local Web surface yet — the window reaches them through the
// preload bridge — so the Web counts below do not move with them.
// +1 for the reading-state write (references:set-reading-status): an ordinary reference write, reachable
// from the window, so it counts on the internal surface and on both Web surfaces.
// +1 for the citation walk (references:discover-citations, B2): reachable from the window, refused on the
// remote surface. It egresses to the index, so it is LOCAL like the integrity check it sits beside.
// +2 for the portable-session package (D1: sessions:export-package / sessions:import-package): the two
// directions a package travels in were Electron-only channels with no command identity, so neither the
// local Web profile nor the command line could reach them. Both are LOCAL — they read and write this
// machine's disk, and an import CREATES a session, which a remote caller must never be able to do.
const INTERNAL_COMMAND_COUNT = 375
// +1 each on internal, local Web and the remote Web dispatch for the screening read
// (references:list-journal-metrics): it is a window-reachable read with no local-only flag, so it is
// counted on both Web surfaces and not on the fail-closed set.
// +3 each on internal, local Web and the remote rejections: the saved-search-filter-set channels are
// reachable from the window locally and are refused on the remote surface, which is where they are counted.
// One more for the skill fork (settings:fork-imported-skill): a plain Web request profile like the
// skill writes it sits beside, so it lands on both Web surfaces and not in the fail-closed set.
// One more for verifying a recorded reading (artifacts:verify-reading): same profile again — a plain
// Web request channel, counted on both Web surfaces and not in the fail-closed set.
// 366 with the citation mark (v2.6.0 A2: references:mark-cited / references:clear-cited): two plain
// reference writes, so they count on both the local and the remote Web surfaces.
// 367 with the session run-data measurement (sessions:read-notebook-usage): same profile — a plain Web
// request, so it lands on both Web surfaces and not in the fail-closed set.
// +2 for the DOI integrity pair: the explicit check (references:check-integrity, LOCAL) is refused
// on the remote surface, the export gate's read (references:read-integrity-summary) is a plain Web
// request, and each exposes one bridge method — so every surface count here moves with them.
// +1 for the citation walk (references:discover-citations, LOCAL): it exposes one bridge method on the
// local Web surface too, and earns the rejecting stub on the remote one.
// +2 for the package pair above: both are reachable from the local Web profile (the headless CLI lands
// there), and neither is in the fail-closed set.
const LOCAL_WEB_COMMAND_COUNT = 373
// Two more as well: the same two channels are mapped, so they count on both the local and the remote Web
// surfaces. The rejected (fail-closed) and task counts are untouched.
// 236 with the session run-data measurement (sessions:read-notebook-usage), which is mapped the same way.
// +2 for the DOI integrity pair: the explicit check (references:check-integrity, LOCAL) is refused
// on the remote surface, the export gate's read (references:read-integrity-summary) is a plain Web
// request, and each exposes one bridge method — so every surface count here moves with them.
const REMOTE_WEB_COMMAND_COUNT = 238
// +1 for verifying a recorded reading (artifacts:verify-reading): local-only by nature, so it lands in
// the fail-closed set instead of the remote dispatch count.
// +1 for the window's PDF translation entry (pdf:translation): local-only, so it lands in the fail-closed
// set instead of the remote dispatch count.
// +2 for the DOI integrity pair: the explicit check (references:check-integrity, LOCAL) is refused
// on the remote surface, the export gate's read (references:read-integrity-summary) is a plain Web
// request, and each exposes one bridge method — so every surface count here moves with them.
// +1 for the citation walk (references:discover-citations, LOCAL): refused on the remote surface, so it
// lands in the fail-closed set rather than the remote dispatch count.
// +2 for the package pair: LOCAL, so they are refused on the remote surface — an import that creates a
// session is exactly the thing a paired browser must not be handed.
const REMOTE_REJECTED_COMMAND_COUNT = 135
// +2 for the portable-session package: the command line exports and imports through the same narrow
// Task view the rest of its machine-readable work uses, so these two land here as well as on the local
// Web profile. They are LOCAL, so they add nothing to the remote dispatch.
const TASK_COMMAND_COUNT = 15
// The external MCP tools this app exposes to an outside client (`purescience mcp`). The list itself lives
// with the tool table in `external-mcp/surface.ts`; this count certifies that adding a tool to the surface
// also reaches the boot-time inventory check instead of silently widening the reachable set. Five since the
// write tool (`archive_session`) joined the four reads — the write is the one the approval gate covers.
const EXTERNAL_MCP_COMMAND_COUNT = 5

const ELECTRON_NATIVE_COMMAND_NAMES = Object.freeze([
  'sessions:export-conversation',
  'uploads:stage-local-file'
])

const TASK_COMMAND_NAMES = Object.freeze([
  'projects:list',
  'projects:create',
  'sessions:load-all',
  'sessions:save-session',
  'artifacts:finalize-run',
  'preview-resources:acquire',
  'preview-resources:release',
  // P3-8: the command line reads the app's own judgements through the same narrow Task view rather
  // than deciding anything for itself.
  'settings:check-environment',
  'runtime:list-environments',
  'settings:list-connectors',
  // 2.1: re-running a recorded version is a read-and-report operation, so the command line reaches it
  // through the same narrow view as the other machine-readable state.
  'artifacts:replay-version',
  // Headless approvals: a `start --no-open` service has no window, so the cards a run is waiting on
  // are readable and answerable from the same narrow view (GET /api/v1/permissions and its approve
  // route). Without these two the command line can start a run but never unblock one.
  'acp:get-state',
  'acp:respond-permission',
  // D1: the portable-session package. The command line is where a package is scripted in and out, and
  // the HTTP routes underneath `purescience package export|import` reach these through the same view.
  'sessions:export-package',
  'sessions:import-package'
])

const APPLICATION_COMMAND_GROUPS = Object.freeze([
  acpApplicationCommands,
  notebookApplicationCommands,
  notebookEnvironmentApplicationCommands,
  runtimeApplicationCommandGroup,
  settingsCoreApplicationCommandGroup,
  settingsSkillApplicationCommandGroup,
  settingsConnectorApplicationCommandGroup,
  settingsApprovalApplicationCommandGroup,
  settingsRuntimeApplicationCommandGroup,
  computeApplicationCommandGroup,
  permissionGrantApplicationCommandGroup,
  referencesApplicationCommandGroup,
  sessionPackageApplicationCommandGroup,
  ...dataContentApplicationCommandGroups,
  ...hostApplicationCommandGroups
])

const failInventory = (detail: string): never => {
  throw new Error(`Application command inventory mismatch: ${detail}`)
}

const collectCatalogCommands = (
  installed: (
    installation: (typeof RENDERER_CONTRACT_CATALOG)[number]['surfaceInstallation']
  ) => boolean
): readonly string[] =>
  Object.freeze(
    RENDERER_CONTRACT_CATALOG.flatMap(({ channel, kind, surfaceInstallation }) =>
      channel !== null && kind === 'method' && installed(surfaceInstallation) ? [channel] : []
    ).sort()
  )

const createRemoteAccessSlot = (): Readonly<{
  owner: RemoteAccessOwner
  bind: (owner: RemoteAccessOwner) => void
  dispose: () => void
}> => {
  let bound: RemoteAccessOwner | undefined
  let disposed = false
  const current = (): RemoteAccessOwner => {
    if (disposed) throw new Error('Remote Access command owner slot is disposed.')
    if (!bound) throw new Error('Remote Access command owner is not bound.')
    return bound
  }
  const owner: RemoteAccessOwner = Object.freeze({
    snapshot: (...args) => current().snapshot(...args),
    detect: (...args) => current().detect(...args),
    setMode: (...args) => current().setMode(...args),
    disable: (...args) => current().disable(...args),
    approve: (...args) => current().approve(...args),
    reject: (...args) => current().reject(...args),
    revoke: (...args) => current().revoke(...args)
  })

  return Object.freeze({
    owner,
    bind: (next): void => {
      if (disposed) throw new Error('Remote Access command owner slot is disposed.')
      if (bound) throw new Error('Remote Access command owner is already bound.')
      bound = next
    },
    dispose: (): void => {
      disposed = true
      bound = undefined
    }
  })
}

const certifyInventory = (): Readonly<{
  commands: ReadonlyMap<string, AnyApplicationCommand>
  localWebNames: readonly string[]
  remoteWebNames: readonly string[]
  remoteRejectedNames: readonly string[]
}> => {
  if (APPLICATION_COMMAND_GROUPS.length !== GROUP_COUNT) {
    failInventory(`expected ${GROUP_COUNT} groups, received ${APPLICATION_COMMAND_GROUPS.length}`)
  }

  const groupNames = new Set<string>()
  const commands = new Map<string, AnyApplicationCommand>()
  for (const group of APPLICATION_COMMAND_GROUPS) {
    if (groupNames.has(group.name)) failInventory(`duplicate group ${group.name}`)
    groupNames.add(group.name)
    for (const command of group.commands) {
      if (commands.has(command.name)) failInventory(`duplicate command ${command.name}`)
      commands.set(command.name, command as AnyApplicationCommand)
    }
  }
  if (commands.size !== INTERNAL_COMMAND_COUNT) {
    failInventory(`expected ${INTERNAL_COMMAND_COUNT} commands, received ${commands.size}`)
  }

  const localWebNames = collectCatalogCommands(({ localWeb }) => localWeb === 'web-rpc')
  const remoteWebNames = collectCatalogCommands(({ remoteWeb }) => remoteWeb === 'web-rpc')
  const remoteRejectedNames = collectCatalogCommands(
    ({ localWeb, remoteWeb }) => localWeb === 'web-rpc' && remoteWeb === 'rejecting-stub'
  )
  const expectedCounts = [
    [localWebNames, LOCAL_WEB_COMMAND_COUNT, 'local Web commands'],
    [remoteWebNames, REMOTE_WEB_COMMAND_COUNT, 'remote Web commands'],
    [remoteRejectedNames, REMOTE_REJECTED_COMMAND_COUNT, 'remote Web rejections'],
    [TASK_COMMAND_NAMES, TASK_COMMAND_COUNT, 'Task commands'],
    [externalMcpCommandNames, EXTERNAL_MCP_COMMAND_COUNT, 'external MCP commands']
  ] as const
  for (const [names, count, label] of expectedCounts) {
    if (names.length !== count)
      failInventory(`expected ${count} ${label}, received ${names.length}`)
    if (new Set(names).size !== names.length) failInventory(`${label} contains duplicate names`)
    for (const name of names) {
      if (!commands.has(name)) failInventory(`${label} contains unknown command ${name}`)
    }
  }

  const nonWebNames = [...commands.keys()].filter((name) => !localWebNames.includes(name)).sort()
  if (nonWebNames.join('\n') !== [...ELECTRON_NATIVE_COMMAND_NAMES].sort().join('\n')) {
    failInventory(`unexpected Electron-native commands ${nonWebNames.join(', ')}`)
  }
  const remotePartition = new Set([...remoteWebNames, ...remoteRejectedNames])
  if (
    remotePartition.size !== localWebNames.length ||
    localWebNames.some((name) => !remotePartition.has(name))
  ) {
    failInventory('remote dispatch and rejection inventories do not partition local Web')
  }

  return Object.freeze({ commands, localWebNames, remoteWebNames, remoteRejectedNames })
}

const createApplicationCommandComposition = (
  dependencies: ApplicationCommandCompositionDependencies,
  onDiagnostic?: (diagnostic: ApplicationCommandDiagnostic) => void
): ApplicationCommandComposition => {
  const certified = certifyInventory()
  const router = createApplicationCommandRouter(onDiagnostic)
  const remoteAccess = createRemoteAccessSlot()
  const installations: ApplicationCommandInstallation[] = []
  let disposed = false

  const installers = [
    () => registerAcpCommands(router.registrar, dependencies.acp),
    () => installNotebookApplicationCommands(router.registrar, dependencies.notebook),
    () =>
      installNotebookEnvironmentApplicationCommands(
        router.registrar,
        dependencies.notebookEnvironment
      ),
    () => registerRuntimeApplicationCommands(router.registrar, dependencies.notebookRuntime),
    () => registerCoreSettingsApplicationCommands(router.registrar, dependencies.settingsCore),
    () =>
      registerIntegrationSettingsApplicationCommands(
        router.registrar,
        dependencies.settingsIntegration
      ),
    () =>
      registerRuntimeSettingsApplicationCommands(router.registrar, dependencies.settingsRuntime),
    () => registerComputeApplicationCommands(router.registrar, dependencies.compute),
    () =>
      registerPermissionGrantApplicationCommands(router.registrar, dependencies.permissionGrants),
    () => registerReferencesApplicationCommands(router.registrar, dependencies.references),
    () => registerDataContentApplicationCommands(router.registrar, dependencies.dataContent),
    () =>
      registerHostApplicationCommands(router.registrar, {
        ...dependencies.host,
        remoteAccess: remoteAccess.owner
      }),
    // D1: registered last. The order is otherwise unchanged on purpose — the package commands sit on top
    // of the host surface they read sessions through, and keeping them at the end leaves every existing
    // install index where it was.
    () => registerSessionPackageApplicationCommands(router.registrar, dependencies.sessionPackage)
  ] as const

  try {
    for (const install of installers) installations.push(install())
  } catch (error) {
    const failures: unknown[] = [error]
    for (const installation of [...installations].reverse()) {
      try {
        installation.uninstall()
      } catch (cleanupError) {
        failures.push(cleanupError)
      }
    }
    try {
      router.dispose()
    } catch (cleanupError) {
      failures.push(cleanupError)
    }
    remoteAccess.dispose()
    if (failures.length > 1) {
      throw new AggregateError(failures, 'Application command composition failed.')
    }
    throw error
  }

  const view = (
    names: readonly string[],
    rejectedNames: readonly string[] = []
  ): ApplicationCommandByNameDispatcher => {
    const allowed = new Set(names)
    const rejected = new Set(rejectedNames)
    return Object.freeze({
      commandNames: (): readonly string[] => names,
      invoke: (commandName, invocation): Promise<unknown> => {
        if (rejected.has(commandName)) {
          return Promise.reject(
            new Error(`Application command is rejected before dispatch: ${commandName}`)
          )
        }
        if (!allowed.has(commandName)) {
          return Promise.reject(
            new Error(`Application command is unavailable in this view: ${commandName}`)
          )
        }
        return router.dispatcher.invoke(certified.commands.get(commandName)!, invocation)
      }
    })
  }

  const localWeb = view(certified.localWebNames)
  const remoteDispatcher = view(certified.remoteWebNames, certified.remoteRejectedNames)
  const remoteWeb = Object.freeze({
    ...remoteDispatcher,
    rejectedCommandNames: (): readonly string[] => certified.remoteRejectedNames
  })
  const task = view(TASK_COMMAND_NAMES)
  const externalMcp = view(externalMcpCommandNames)
  // The gate an outside client's write crosses. Deliberately routed through `requestAppApproval` (always a
  // card) and not through the provider permission path (which honours the conversation's profile): an
  // outside client must never inherit the auto-approval the user granted to their own agent. A conversation
  // this process has not loaded cannot be asked — that is `unavailable`, i.e. refused, never allowed.
  const externalApprovalLog = createLogger('external-mcp')
  const externalApproval: ExternalMcpRequestApproval = async (input) => {
    if (!input.sessionId) return 'unavailable'
    try {
      const approved = await dependencies.acp.runtime.requestAppApproval({
        sessionId: input.sessionId,
        title: input.title,
        rawInput: input.rawInput,
        external: { tool: input.toolId, toolCallId: input.toolCallId }
      })
      externalApprovalLog.info('external mcp approval answered', {
        toolCallId: input.toolCallId,
        tool: input.toolId,
        sessionId: input.sessionId,
        approved
      })
      return approved ? 'approved' : 'declined'
    } catch (error) {
      externalApprovalLog.warn('external mcp approval unavailable', {
        toolCallId: input.toolCallId,
        tool: input.toolId,
        sessionId: input.sessionId,
        message: error instanceof Error ? error.message : String(error)
      })
      return 'unavailable'
    }
  }

  return Object.freeze({
    localWeb,
    remoteWeb,
    task,
    externalMcp,
    externalApproval,
    bindRemoteAccess: remoteAccess.bind,
    dispose: (): void => {
      if (disposed) return
      disposed = true
      const failures: unknown[] = []
      for (const installation of [...installations].reverse()) {
        try {
          installation.uninstall()
        } catch (error) {
          failures.push(error)
        }
      }
      try {
        router.dispose()
      } catch (error) {
        failures.push(error)
      }
      remoteAccess.dispose()
      if (failures.length > 0) {
        throw new AggregateError(failures, 'Application command composition cleanup failed.')
      }
    }
  })
}

export { createApplicationCommandComposition }
export type {
  ApplicationCommandByNameDispatcher,
  ApplicationCommandComposition,
  ApplicationCommandCompositionDependencies,
  RemoteAccessOwner,
  RemoteWebApplicationCommandDispatcher
}
