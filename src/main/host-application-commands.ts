import type { ArtifactPreviewResult, ReadArtifactPreviewRequest } from '../shared/artifacts'
import type { CliLauncherStatus } from '../shared/cli'
import type {
  FolderGrant,
  FolderGrantRequest,
  FolderGrantRevokeRequest,
  FolderGrantsSnapshot
} from '../shared/folder-grants'
import type { LocalDirListing, LocalRoots } from '../shared/local-fs'
import type { OpenLogFileResult, RevealLogFileResult } from '../shared/logs'
import type { OpenSessionFromNotificationRequest } from '../shared/notifications'
import type {
  ApproveRemotePairingRequest,
  RemoteAccessSnapshot,
  RemotePairingRequestId,
  RevokeRemoteBrowserRequest,
  SetRemoteAccessModeRequest
} from '../shared/remote-access'
import type {
  ReviewRunRequest,
  ReviewRunResult,
  ReviewSessionRequest,
  ReviewWithChecks,
  VerificationChecklist,
  VerificationChecklistMutationRequest,
  ContextSummaryChunkView
} from '../shared/reviewer'
import type {
  ActiveSessionInfo,
  DataRootInspection,
  DataRootValidationResult,
  MigrationOutcome,
  RevealAppStorageResult,
  StorageInfo
} from '../shared/storage'
import type { AppInfo, UpdateStatus } from '../shared/update'
import type { RoutineSchedule } from '../shared/routine'
import type { RoutineConfigureRequest } from '../shared/routine'
import type { ManagedEndpoint } from '../shared/endpoint'
import type { EndpointRegisterRequest } from '../shared/endpoint'
import type { EndpointCommandOwner } from './settings/endpoint-ipc'
import type { FileAnnotation, AnnotationSetRequest } from '../shared/annotation'
import type { AnnotationCommandOwner } from './settings/annotation-ipc'
import type { PdfOpenResult, PdfPagesResult, PdfOutlineResult, PdfScanResult } from '../shared/pdf'
import type { PdfCommandOwner } from './settings/pdf-ipc'
import type { FigureReviewResult, FigureReviewRequest } from '../shared/figure'
import type { FigureCommandOwner } from './settings/figure-ipc'
import type { HostQueryResult } from '../shared/host-query'
import type { HostQueryCommandOwner } from './settings/host-query-ipc'
import {
  defineApplicationCommand,
  defineApplicationCommandGroup,
  type ApplicationCommandInstallation,
  type ApplicationCommandRegistrar
} from './application-command-router'
import type { CallerContext } from './caller-context'
import type { CliCommandOwner } from './cli-install/ipc'
import type { FolderGrantsService } from './folder-grants'
import type { GithubCommandOwner } from './github-ipc'
import type { LocalFsService } from './local-fs/service'
import type { LogsCommandOwner } from './logs-ipc'
import {
  canManagePairing,
  isDesktopCaller,
  requireDesktopCaller,
  requirePairingManager
} from './remote-access/ipc'
import type { RemoteAccessService } from './remote-access/service'
import type { ReviewerCommandOwner } from './reviewer/ipc'
import type { UpdateCommandOwner } from './update/ipc'

type StorageParentRequest = Readonly<{ parent: string }>
type StorageRootRequest = Readonly<{ parent: string; markOnboarding?: boolean }>

const cliCommands = Object.freeze({
  getStatus: defineApplicationCommand<'cli:get-status', readonly [], CliLauncherStatus>(
    'cli:get-status'
  ),
  install: defineApplicationCommand<'cli:install', readonly [], CliLauncherStatus>('cli:install'),
  uninstall: defineApplicationCommand<'cli:uninstall', readonly [], CliLauncherStatus>(
    'cli:uninstall'
  )
})

const githubCommands = Object.freeze({
  getStars: defineApplicationCommand<'github:get-stars', readonly [], number | null>(
    'github:get-stars'
  )
})

const localFsCommands = Object.freeze({
  getRoots: defineApplicationCommand<'local-fs:get-roots', readonly [], LocalRoots>(
    'local-fs:get-roots'
  ),
  listDir: defineApplicationCommand<'local-fs:list-dir', readonly [path: string], LocalDirListing>(
    'local-fs:list-dir'
  ),
  openPath: defineApplicationCommand<'local-fs:open-path', readonly [path: string], string>(
    'local-fs:open-path'
  ),
  readPreview: defineApplicationCommand<
    'local-fs:read-preview',
    readonly [request: ReadArtifactPreviewRequest],
    ArtifactPreviewResult
  >('local-fs:read-preview'),
  reveal: defineApplicationCommand<'local-fs:reveal', readonly [path: string], void>(
    'local-fs:reveal'
  )
})

const logsCommands = Object.freeze({
  getPath: defineApplicationCommand<'logs:get-path', readonly [], string | null>('logs:get-path'),
  openFile: defineApplicationCommand<'logs:open-file', readonly [], OpenLogFileResult>(
    'logs:open-file'
  ),
  revealInFolder: defineApplicationCommand<
    'logs:reveal-in-folder',
    readonly [],
    RevealLogFileResult
  >('logs:reveal-in-folder')
})

const folderGrantsCommands = Object.freeze({
  grant: defineApplicationCommand<
    'folder-grants:grant',
    readonly [request: FolderGrantRequest],
    FolderGrant
  >('folder-grants:grant'),
  list: defineApplicationCommand<'folder-grants:list', readonly [], FolderGrantsSnapshot>(
    'folder-grants:list'
  ),
  revoke: defineApplicationCommand<
    'folder-grants:revoke',
    readonly [request: FolderGrantRevokeRequest],
    boolean
  >('folder-grants:revoke')
})

const notificationCommands = Object.freeze({
  peekPendingOpenSession: defineApplicationCommand<
    'notifications:peek-pending-open-session',
    readonly [],
    OpenSessionFromNotificationRequest | null
  >('notifications:peek-pending-open-session'),
  takePendingOpenSession: defineApplicationCommand<
    'notifications:take-pending-open-session',
    readonly [expectedToken: unknown],
    OpenSessionFromNotificationRequest | null
  >('notifications:take-pending-open-session')
})

const remoteAccessCommands = Object.freeze({
  approve: defineApplicationCommand<
    'remote-access:approve',
    readonly [request: ApproveRemotePairingRequest],
    RemoteAccessSnapshot
  >('remote-access:approve'),
  detect: defineApplicationCommand<'remote-access:detect', readonly [], RemoteAccessSnapshot>(
    'remote-access:detect'
  ),
  disable: defineApplicationCommand<'remote-access:disable', readonly [], RemoteAccessSnapshot>(
    'remote-access:disable'
  ),
  getSnapshot: defineApplicationCommand<
    'remote-access:get-snapshot',
    readonly [],
    RemoteAccessSnapshot
  >('remote-access:get-snapshot'),
  reject: defineApplicationCommand<
    'remote-access:reject',
    readonly [request: RemotePairingRequestId],
    RemoteAccessSnapshot
  >('remote-access:reject'),
  revokeBrowser: defineApplicationCommand<
    'remote-access:revoke-browser',
    readonly [request: RevokeRemoteBrowserRequest],
    RemoteAccessSnapshot
  >('remote-access:revoke-browser'),
  setMode: defineApplicationCommand<
    'remote-access:set-mode',
    readonly [request: SetRemoteAccessModeRequest],
    RemoteAccessSnapshot
  >('remote-access:set-mode')
})

const reviewerCommands = Object.freeze({
  abortFixLoop: defineApplicationCommand<
    'reviewer:abort-fix-loop',
    readonly [request: ReviewSessionRequest],
    void
  >('reviewer:abort-fix-loop'),
  getChecklist: defineApplicationCommand<
    'reviewer:get-checklist',
    readonly [request: ReviewSessionRequest],
    VerificationChecklist
  >('reviewer:get-checklist'),
  getForSession: defineApplicationCommand<
    'reviewer:get-for-session',
    readonly [request: ReviewSessionRequest],
    ReviewWithChecks[]
  >('reviewer:get-for-session'),
  mutateChecklist: defineApplicationCommand<
    'reviewer:mutate-checklist',
    readonly [request: VerificationChecklistMutationRequest],
    void
  >('reviewer:mutate-checklist'),
  getChunks: defineApplicationCommand<
    'reviewer:get-chunks',
    readonly [request: ReviewSessionRequest],
    ContextSummaryChunkView[]
  >('reviewer:get-chunks'),
  run: defineApplicationCommand<
    'reviewer:run',
    readonly [request: ReviewRunRequest],
    ReviewRunResult
  >('reviewer:run')
})

const storageCommands = Object.freeze({
  cancelMigrate: defineApplicationCommand<'storage:cancel-migrate', readonly [], void>(
    'storage:cancel-migrate'
  ),
  commitAndRelaunch: defineApplicationCommand<
    'storage:commit-and-relaunch',
    readonly [request: StorageParentRequest],
    MigrationOutcome
  >('storage:commit-and-relaunch'),
  detectActive: defineApplicationCommand<'storage:detect-active', readonly [], ActiveSessionInfo[]>(
    'storage:detect-active'
  ),
  discardMigratedCopy: defineApplicationCommand<
    'storage:discard-migrated-copy',
    readonly [request: StorageParentRequest],
    void
  >('storage:discard-migrated-copy'),
  dismissLegacyMovePrompt: defineApplicationCommand<
    'storage:dismiss-legacy-move-prompt',
    readonly [],
    void
  >('storage:dismiss-legacy-move-prompt'),
  getInfo: defineApplicationCommand<'storage:get-info', readonly [], StorageInfo>(
    'storage:get-info'
  ),
  inspectDataRoot: defineApplicationCommand<
    'storage:inspect-data-root',
    readonly [request: StorageParentRequest],
    DataRootInspection
  >('storage:inspect-data-root'),
  migrate: defineApplicationCommand<
    'storage:migrate',
    readonly [request: StorageParentRequest],
    MigrationOutcome
  >('storage:migrate'),
  pickDirectory: defineApplicationCommand<'storage:pick-directory', readonly [], string | null>(
    'storage:pick-directory'
  ),
  revealAppStorage: defineApplicationCommand<
    'storage:reveal-app-storage',
    readonly [],
    RevealAppStorageResult
  >('storage:reveal-app-storage'),
  setDataRootAndRelaunch: defineApplicationCommand<
    'storage:set-data-root-and-relaunch',
    readonly [request: StorageRootRequest],
    DataRootValidationResult
  >('storage:set-data-root-and-relaunch'),
  validateDataRoot: defineApplicationCommand<
    'storage:validate-data-root',
    readonly [request: StorageParentRequest],
    DataRootValidationResult
  >('storage:validate-data-root')
})

const updateCommands = Object.freeze({
  apply: defineApplicationCommand<'update:apply', readonly [], UpdateStatus>('update:apply'),
  cancel: defineApplicationCommand<'update:cancel', readonly [], UpdateStatus>('update:cancel'),
  check: defineApplicationCommand<'update:check', readonly [], UpdateStatus>('update:check'),
  download: defineApplicationCommand<'update:download', readonly [], UpdateStatus>(
    'update:download'
  ),
  getAppInfo: defineApplicationCommand<'update:get-app-info', readonly [], AppInfo>(
    'update:get-app-info'
  ),
  getStatus: defineApplicationCommand<'update:get-status', readonly [], UpdateStatus>(
    'update:get-status'
  )
})

const routineCommands = Object.freeze({
  listAll: defineApplicationCommand<'routine:list-all', readonly [], RoutineSchedule[]>(
    'routine:list-all'
  ),
  upsert: defineApplicationCommand<
    'routine:upsert',
    readonly [request: { sessionId: string; configure: RoutineConfigureRequest }],
    RoutineSchedule
  >('routine:upsert'),
  remove: defineApplicationCommand<
    'routine:remove',
    readonly [request: { sessionId: string; routineId: string }],
    boolean
  >('routine:remove'),
  setEnabled: defineApplicationCommand<
    'routine:set-enabled',
    readonly [request: { sessionId: string; routineId: string; enabled: boolean }],
    RoutineSchedule | null
  >('routine:set-enabled')
})

const endpointCommands = Object.freeze({
  listAll: defineApplicationCommand<'endpoint:list-all', readonly [], ManagedEndpoint[]>(
    'endpoint:list-all'
  ),
  register: defineApplicationCommand<
    'endpoint:register',
    readonly [request: { sessionId: string; request: EndpointRegisterRequest }],
    { endpoint: ManagedEndpoint; newlyApproved: boolean }
  >('endpoint:register'),
  approve: defineApplicationCommand<'endpoint:approve', readonly [name: string], boolean>(
    'endpoint:approve'
  ),
  start: defineApplicationCommand<'endpoint:start', readonly [name: string], ManagedEndpoint>(
    'endpoint:start'
  ),
  stop: defineApplicationCommand<'endpoint:stop', readonly [name: string], ManagedEndpoint>(
    'endpoint:stop'
  ),
  remove: defineApplicationCommand<'endpoint:remove', readonly [name: string], boolean>(
    'endpoint:remove'
  )
})

const annotationCommands = Object.freeze({
  set: defineApplicationCommand<
    'annotation:set',
    readonly [request: { projectId: string; request: AnnotationSetRequest }],
    { annotation: FileAnnotation; replaced: boolean }
  >('annotation:set'),
  list: defineApplicationCommand<
    'annotation:list',
    readonly [request: { projectId: string; target?: string }],
    FileAnnotation[]
  >('annotation:list'),
  remove: defineApplicationCommand<
    'annotation:remove',
    readonly [request: { projectId: string; annotationId: string }],
    boolean
  >('annotation:remove')
})

const pdfCommands = Object.freeze({
  open: defineApplicationCommand<
    'pdf:open',
    readonly [request: { projectId: string; path: string }],
    PdfOpenResult
  >('pdf:open'),
  pages: defineApplicationCommand<
    'pdf:pages',
    readonly [request: { projectId: string; docId: string; start: number; end?: number }],
    PdfPagesResult
  >('pdf:pages'),
  outline: defineApplicationCommand<
    'pdf:outline',
    readonly [request: { projectId: string; docId: string }],
    PdfOutlineResult
  >('pdf:outline'),
  scan: defineApplicationCommand<
    'pdf:scan',
    readonly [request: { projectId: string; docId: string; query: string }],
    PdfScanResult
  >('pdf:scan')
})

const figureCommands = Object.freeze({
  review: defineApplicationCommand<
    'figure:review',
    readonly [request: { projectId: string; request: FigureReviewRequest }],
    FigureReviewResult
  >('figure:review')
})

const queryCommands = Object.freeze({
  run: defineApplicationCommand<
    'query:run',
    readonly [request: { projectId: string; sql: string }],
    HostQueryResult
  >('query:run')
})

const hostApplicationCommands = Object.freeze({
  cli: cliCommands,
  folderGrants: folderGrantsCommands,
  github: githubCommands,
  localFs: localFsCommands,
  logs: logsCommands,
  notifications: notificationCommands,
  remoteAccess: remoteAccessCommands,
  reviewer: reviewerCommands,
  routine: routineCommands,
  endpoint: endpointCommands,
  annotation: annotationCommands,
  pdf: pdfCommands,
  figure: figureCommands,
  query: queryCommands,
  storage: storageCommands,
  update: updateCommands
})

const hostApplicationCommandGroups = Object.freeze([
  defineApplicationCommandGroup('cli', Object.values(cliCommands)),
  defineApplicationCommandGroup('folderGrants', Object.values(folderGrantsCommands)),
  defineApplicationCommandGroup('github', Object.values(githubCommands)),
  defineApplicationCommandGroup('local-fs', Object.values(localFsCommands)),
  defineApplicationCommandGroup('logs', Object.values(logsCommands)),
  defineApplicationCommandGroup('notifications', Object.values(notificationCommands)),
  defineApplicationCommandGroup('remote-access', Object.values(remoteAccessCommands)),
  defineApplicationCommandGroup('reviewer', Object.values(reviewerCommands)),
  defineApplicationCommandGroup('routine', Object.values(routineCommands)),
  defineApplicationCommandGroup('endpoint', Object.values(endpointCommands)),
  defineApplicationCommandGroup('annotation', Object.values(annotationCommands)),
  defineApplicationCommandGroup('pdf', Object.values(pdfCommands)),
  defineApplicationCommandGroup('figure', Object.values(figureCommands)),
  defineApplicationCommandGroup('query', Object.values(queryCommands)),
  defineApplicationCommandGroup('storage', Object.values(storageCommands)),
  defineApplicationCommandGroup('update', Object.values(updateCommands))
] as const)

type HostApplicationCommandDependencies = Readonly<{
  cli: CliCommandOwner
  folderGrants: Pick<FolderGrantsService, 'grant' | 'list' | 'revoke'>
  github: GithubCommandOwner
  localFs: Pick<
    LocalFsService,
    'getRoots' | 'listDir' | 'openPath' | 'readPreview' | 'revealInFolder'
  >
  logs: LogsCommandOwner
  notifications: Readonly<{
    peekPendingOpenSession: () => OpenSessionFromNotificationRequest | null
    takePendingOpenSession: (expectedToken: number) => OpenSessionFromNotificationRequest | null
  }>
  remoteAccess: Pick<
    RemoteAccessService,
    'snapshot' | 'detect' | 'setMode' | 'disable' | 'approve' | 'reject' | 'revoke'
  >
  reviewer: Pick<
    ReviewerCommandOwner,
    'run' | 'getForSession' | 'abortFixLoop' | 'getChecklist' | 'mutateChecklist' | 'getChunks'
  >
  routine: Readonly<{
    listAll: () => Promise<RoutineSchedule[]>
    upsert: (sessionId: string, configure: RoutineConfigureRequest) => Promise<RoutineSchedule>
    remove: (sessionId: string, routineId: string) => Promise<boolean>
    setEnabled: (
      sessionId: string,
      routineId: string,
      enabled: boolean
    ) => Promise<RoutineSchedule | null>
  }>
  endpoint: EndpointCommandOwner
  annotation: AnnotationCommandOwner
  pdf: PdfCommandOwner
  figure: FigureCommandOwner
  query: HostQueryCommandOwner
  storage: Readonly<{
    getInfo: () => Promise<StorageInfo>
    revealAppStorage: () => Promise<RevealAppStorageResult>
    detectActive: () => ActiveSessionInfo[]
    pickDirectory: () => Promise<string | null>
    validateDataRoot: (request: StorageParentRequest) => Promise<DataRootValidationResult>
    inspectDataRoot: (request: StorageParentRequest) => Promise<DataRootInspection>
    migrate: (request: StorageParentRequest) => Promise<MigrationOutcome>
    setDataRootAndRelaunch: (request: StorageRootRequest) => Promise<DataRootValidationResult>
    cancelMigrate: () => void
    commitAndRelaunch: (request: StorageParentRequest) => Promise<MigrationOutcome>
    discardMigratedCopy: (request: StorageParentRequest) => Promise<void>
    dismissLegacyMovePrompt: () => Promise<void>
  }>
  update: UpdateCommandOwner
}>

const localCommand = <Result>(
  context: CallerContext,
  channel: string,
  invoke: () => Result
): Result => {
  if (context.location !== 'local') {
    throw new Error(`Channel only available from the local app: ${channel}`)
  }
  return invoke()
}

// Production composition registers all bounded command groups atomically; this group must not be
// exposed through a live transport in isolation.
const registerHostApplicationCommands = (
  registrar: ApplicationCommandRegistrar,
  dependencies: HostApplicationCommandDependencies
): ApplicationCommandInstallation => {
  const scope = registrar.createScope()
  try {
    scope.registerGroup(hostApplicationCommandGroups[0], {
      'cli:get-status': () => dependencies.cli.getStatus(),
      'cli:install': ({ callerContext }) =>
        localCommand(callerContext, 'cli:install', () => dependencies.cli.install()),
      'cli:uninstall': ({ callerContext }) =>
        localCommand(callerContext, 'cli:uninstall', () => dependencies.cli.uninstall())
    })
    scope.registerGroup(hostApplicationCommandGroups[1], {
      'folder-grants:grant': ({ args, callerContext }) =>
        localCommand(callerContext, 'folder-grants:grant', () =>
          dependencies.folderGrants.grant(args[0].path)
        ),
      'folder-grants:list': ({ callerContext }) =>
        localCommand(callerContext, 'folder-grants:list', () => dependencies.folderGrants.list()),
      'folder-grants:revoke': ({ args, callerContext }) =>
        localCommand(callerContext, 'folder-grants:revoke', () =>
          dependencies.folderGrants.revoke(args[0].rootId)
        )
    })
    scope.registerGroup(hostApplicationCommandGroups[2], {
      'github:get-stars': () => dependencies.github.getStars()
    })
    scope.registerGroup(hostApplicationCommandGroups[3], {
      'local-fs:get-roots': ({ callerContext }) =>
        localCommand(callerContext, 'local-fs:get-roots', () => dependencies.localFs.getRoots()),
      'local-fs:list-dir': ({ args, callerContext }) =>
        localCommand(callerContext, 'local-fs:list-dir', () =>
          dependencies.localFs.listDir(args[0])
        ),
      'local-fs:open-path': ({ args, callerContext }) =>
        localCommand(callerContext, 'local-fs:open-path', () =>
          dependencies.localFs.openPath(args[0])
        ),
      'local-fs:read-preview': ({ args, callerContext }) =>
        localCommand(callerContext, 'local-fs:read-preview', () =>
          dependencies.localFs.readPreview(args[0])
        ),
      'local-fs:reveal': ({ args, callerContext }) =>
        localCommand(callerContext, 'local-fs:reveal', () =>
          dependencies.localFs.revealInFolder(args[0])
        )
    })
    scope.registerGroup(hostApplicationCommandGroups[4], {
      'logs:get-path': () => dependencies.logs.getPath(),
      'logs:open-file': ({ callerContext }) =>
        localCommand(callerContext, 'logs:open-file', () => dependencies.logs.openFile()),
      'logs:reveal-in-folder': ({ callerContext }) =>
        localCommand(callerContext, 'logs:reveal-in-folder', () =>
          dependencies.logs.revealInFolder()
        )
    })
    scope.registerGroup(hostApplicationCommandGroups[5], {
      'notifications:peek-pending-open-session': () =>
        dependencies.notifications.peekPendingOpenSession(),
      'notifications:take-pending-open-session': ({ args }) =>
        typeof args[0] === 'number' && Number.isSafeInteger(args[0]) && args[0] > 0
          ? dependencies.notifications.takePendingOpenSession(args[0])
          : null
    })
    scope.registerGroup(hostApplicationCommandGroups[6], {
      'remote-access:approve': ({ args, callerContext }) => {
        requirePairingManager(callerContext)
        const desktop = isDesktopCaller(callerContext)
        return dependencies.remoteAccess.approve(args[0], desktop, canManagePairing(callerContext))
      },
      'remote-access:detect': ({ callerContext }) => {
        requireDesktopCaller(callerContext)
        return dependencies.remoteAccess.detect()
      },
      'remote-access:disable': ({ callerContext }) => {
        requireDesktopCaller(callerContext)
        return dependencies.remoteAccess.disable()
      },
      'remote-access:get-snapshot': ({ callerContext }) => {
        const desktop = isDesktopCaller(callerContext)
        return dependencies.remoteAccess.snapshot(desktop, canManagePairing(callerContext))
      },
      'remote-access:reject': ({ args, callerContext }) => {
        requirePairingManager(callerContext)
        const desktop = isDesktopCaller(callerContext)
        return dependencies.remoteAccess.reject(
          args[0].requestId,
          desktop,
          canManagePairing(callerContext)
        )
      },
      'remote-access:revoke-browser': ({ args, callerContext }) => {
        requirePairingManager(callerContext)
        const desktop = isDesktopCaller(callerContext)
        return dependencies.remoteAccess.revoke(
          args[0].browserId,
          desktop,
          canManagePairing(callerContext)
        )
      },
      'remote-access:set-mode': ({ args, callerContext }) => {
        requireDesktopCaller(callerContext)
        return dependencies.remoteAccess.setMode(args[0].mode)
      }
    })
    scope.registerGroup(hostApplicationCommandGroups[7], {
      'reviewer:abort-fix-loop': ({ args }) => dependencies.reviewer.abortFixLoop(args[0]),
      'reviewer:get-checklist': ({ args }) => dependencies.reviewer.getChecklist(args[0]),
      'reviewer:get-for-session': ({ args }) => dependencies.reviewer.getForSession(args[0]),
      'reviewer:mutate-checklist': ({ args }) => dependencies.reviewer.mutateChecklist(args[0]),
      'reviewer:get-chunks': ({ args }) => dependencies.reviewer.getChunks(args[0]),
      'reviewer:run': ({ args }) => dependencies.reviewer.run(args[0])
    })
    scope.registerGroup(hostApplicationCommandGroups[8], {
      'routine:list-all': ({ callerContext }) =>
        localCommand(callerContext, 'routine:list-all', () => dependencies.routine.listAll()),
      'routine:upsert': ({ args, callerContext }) =>
        localCommand(callerContext, 'routine:upsert', () =>
          dependencies.routine.upsert(args[0].sessionId, args[0].configure)
        ),
      'routine:remove': ({ args, callerContext }) =>
        localCommand(callerContext, 'routine:remove', () =>
          dependencies.routine.remove(args[0].sessionId, args[0].routineId)
        ),
      'routine:set-enabled': ({ args, callerContext }) =>
        localCommand(callerContext, 'routine:set-enabled', () =>
          dependencies.routine.setEnabled(args[0].sessionId, args[0].routineId, args[0].enabled)
        )
    })
    scope.registerGroup(hostApplicationCommandGroups[9], {
      'endpoint:list-all': ({ callerContext }) =>
        localCommand(callerContext, 'endpoint:list-all', () => dependencies.endpoint.listAll()),
      'endpoint:register': ({ args, callerContext }) =>
        localCommand(callerContext, 'endpoint:register', () =>
          dependencies.endpoint.register(args[0].sessionId, args[0].request)
        ),
      'endpoint:approve': ({ args, callerContext }) =>
        localCommand(callerContext, 'endpoint:approve', () =>
          dependencies.endpoint.approve(args[0])
        ),
      'endpoint:start': ({ args, callerContext }) =>
        localCommand(callerContext, 'endpoint:start', () => dependencies.endpoint.start(args[0])),
      'endpoint:stop': ({ args, callerContext }) =>
        localCommand(callerContext, 'endpoint:stop', () => dependencies.endpoint.stop(args[0])),
      'endpoint:remove': ({ args, callerContext }) =>
        localCommand(callerContext, 'endpoint:remove', () => dependencies.endpoint.remove(args[0]))
    })
    scope.registerGroup(hostApplicationCommandGroups[10], {
      'annotation:set': ({ args, callerContext }) =>
        localCommand(callerContext, 'annotation:set', () =>
          dependencies.annotation.set(args[0].projectId, args[0].request)
        ),
      'annotation:list': ({ args, callerContext }) =>
        localCommand(callerContext, 'annotation:list', () =>
          dependencies.annotation.list(args[0].projectId, args[0].target)
        ),
      'annotation:remove': ({ args, callerContext }) =>
        localCommand(callerContext, 'annotation:remove', () =>
          dependencies.annotation.remove(args[0].projectId, args[0].annotationId)
        )
    })
    scope.registerGroup(hostApplicationCommandGroups[11], {
      'pdf:open': ({ args, callerContext }) =>
        localCommand(callerContext, 'pdf:open', () =>
          dependencies.pdf.open(args[0].projectId, args[0].path)
        ),
      'pdf:pages': ({ args, callerContext }) =>
        localCommand(callerContext, 'pdf:pages', () =>
          dependencies.pdf.pages(args[0].projectId, args[0].docId, args[0].start, args[0].end)
        ),
      'pdf:outline': ({ args, callerContext }) =>
        localCommand(callerContext, 'pdf:outline', () =>
          dependencies.pdf.outline(args[0].projectId, args[0].docId)
        ),
      'pdf:scan': ({ args, callerContext }) =>
        localCommand(callerContext, 'pdf:scan', () =>
          dependencies.pdf.scan(args[0].projectId, args[0].docId, args[0].query)
        )
    })
    scope.registerGroup(hostApplicationCommandGroups[12], {
      'figure:review': ({ args, callerContext }) =>
        localCommand(callerContext, 'figure:review', () =>
          dependencies.figure.review(args[0].projectId, args[0].request)
        )
    })
    scope.registerGroup(hostApplicationCommandGroups[13], {
      'query:run': ({ args, callerContext }) =>
        localCommand(callerContext, 'query:run', () =>
          dependencies.query.run(args[0].projectId, args[0].sql)
        )
    })
    scope.registerGroup(hostApplicationCommandGroups[14], {
      'storage:cancel-migrate': ({ callerContext }) =>
        localCommand(callerContext, 'storage:cancel-migrate', () =>
          dependencies.storage.cancelMigrate()
        ),
      'storage:commit-and-relaunch': ({ args, callerContext }) =>
        localCommand(callerContext, 'storage:commit-and-relaunch', () =>
          dependencies.storage.commitAndRelaunch(args[0])
        ),
      'storage:detect-active': () => dependencies.storage.detectActive(),
      'storage:discard-migrated-copy': ({ args, callerContext }) =>
        localCommand(callerContext, 'storage:discard-migrated-copy', () =>
          dependencies.storage.discardMigratedCopy(args[0])
        ),
      'storage:dismiss-legacy-move-prompt': () => dependencies.storage.dismissLegacyMovePrompt(),
      'storage:get-info': () => dependencies.storage.getInfo(),
      'storage:inspect-data-root': ({ args, callerContext }) =>
        localCommand(callerContext, 'storage:inspect-data-root', () =>
          dependencies.storage.inspectDataRoot(args[0])
        ),
      'storage:migrate': ({ args, callerContext }) =>
        localCommand(callerContext, 'storage:migrate', () => dependencies.storage.migrate(args[0])),
      'storage:pick-directory': ({ callerContext }) =>
        localCommand(callerContext, 'storage:pick-directory', () =>
          dependencies.storage.pickDirectory()
        ),
      'storage:reveal-app-storage': ({ callerContext }) =>
        localCommand(callerContext, 'storage:reveal-app-storage', () =>
          dependencies.storage.revealAppStorage()
        ),
      'storage:set-data-root-and-relaunch': ({ args, callerContext }) =>
        localCommand(callerContext, 'storage:set-data-root-and-relaunch', () =>
          dependencies.storage.setDataRootAndRelaunch(args[0])
        ),
      'storage:validate-data-root': ({ args, callerContext }) =>
        localCommand(callerContext, 'storage:validate-data-root', () =>
          dependencies.storage.validateDataRoot(args[0])
        )
    })
    scope.registerGroup(hostApplicationCommandGroups[15], {
      'update:apply': ({ callerContext }) =>
        localCommand(callerContext, 'update:apply', () => dependencies.update.apply()),
      'update:cancel': ({ callerContext }) =>
        localCommand(callerContext, 'update:cancel', () => dependencies.update.cancel()),
      'update:check': () => dependencies.update.check(),
      'update:download': ({ callerContext }) =>
        localCommand(callerContext, 'update:download', () => dependencies.update.download()),
      'update:get-app-info': () => dependencies.update.getAppInfo(),
      'update:get-status': () => dependencies.update.getStatus()
    })
    return scope.complete()
  } catch (error) {
    scope.rollback()
    throw error
  }
}

export { hostApplicationCommandGroups, hostApplicationCommands, registerHostApplicationCommands }
export type { HostApplicationCommandDependencies }
