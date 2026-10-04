import { RENDERER_CONTRACT_CATALOG } from '../shared/renderer-contract-catalog'
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
  host: Omit<HostApplicationCommandDependencies, 'remoteAccess'>
}>

type ApplicationCommandComposition = Readonly<{
  localWeb: ApplicationCommandByNameDispatcher
  remoteWeb: RemoteWebApplicationCommandDispatcher
  task: ApplicationCommandByNameDispatcher
  bindRemoteAccess: (owner: RemoteAccessOwner) => void
  dispose: () => void
}>

const GROUP_COUNT = 39
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
const INTERNAL_COMMAND_COUNT = 351
// +1 each on internal, local Web and the remote Web dispatch for the screening read
// (references:list-journal-metrics): it is a window-reachable read with no local-only flag, so it is
// counted on both Web surfaces and not on the fail-closed set.
// +3 each on internal, local Web and the remote rejections: the saved-search-filter-set channels are
// reachable from the window locally and are refused on the remote surface, which is where they are counted.
const LOCAL_WEB_COMMAND_COUNT = 349
// Two more as well: the same two channels are mapped, so they count on both the local and the remote Web
// surfaces. The rejected (fail-closed) and task counts are untouched.
const REMOTE_WEB_COMMAND_COUNT = 226
const REMOTE_REJECTED_COMMAND_COUNT = 123
const TASK_COMMAND_COUNT = 11

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
  'artifacts:replay-version'
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
    [TASK_COMMAND_NAMES, TASK_COMMAND_COUNT, 'Task commands']
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
      })
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

  return Object.freeze({
    localWeb,
    remoteWeb,
    task,
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
