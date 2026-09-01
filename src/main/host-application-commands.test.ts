import { describe, expect, it, vi } from 'vitest'

import type { RemoteAccessSnapshot } from '../shared/remote-access'
import type { RoutineConfigureRequest } from '../shared/routine'
import type { EndpointRegisterRequest, ManagedEndpoint } from '../shared/endpoint'
import type { AnnotationSetRequest, FileAnnotation } from '../shared/annotation'
import type { PdfOpenResult, PdfOutlineResult, PdfPagesResult, PdfScanResult } from '../shared/pdf'
import { RENDERER_CONTRACT_GROUPS } from '../shared/renderer-contract-catalog'
import type { UpdateStatus } from '../shared/update'
import {
  createApplicationCommandRouter,
  type ApplicationCallerLease,
  type ApplicationCommand,
  type ApplicationInvocation
} from './application-command-router'
import {
  createElectronCallerContext,
  createWebCallerContext,
  type CallerContext
} from './caller-context'
import {
  hostApplicationCommandGroups,
  hostApplicationCommands,
  registerHostApplicationCommands,
  type HostApplicationCommandDependencies
} from './host-application-commands'

const HOST_CAPABILITIES = [
  'cli',
  'folderGrants',
  'github',
  'local-fs',
  'logs',
  'notifications',
  'remote-access',
  'reviewer',
  'routine',
  'endpoint',
  'annotation',
  'pdf',
  'storage',
  'update'
] as const

const remoteSnapshot: RemoteAccessSnapshot = {
  canManage: true,
  canManagePairing: true,
  mode: 'off',
  enabled: false,
  lifecycle: 'disabled',
  remoteIt: { installed: false, loggedIn: false, registered: false },
  pendingRequests: [],
  trustedBrowsers: []
}

const updateStatus: UpdateStatus = { state: 'idle', current: '1.0.0' }

const createDependencies = (): HostApplicationCommandDependencies => ({
  cli: {
    getStatus: vi.fn(async () => ({
      installed: false,
      target: '/bin/purescience',
      onPath: false
    })),
    install: vi.fn(async () => ({ installed: true, target: '/bin/purescience', onPath: true })),
    uninstall: vi.fn(async () => ({ installed: false, target: '/bin/purescience', onPath: true }))
  },
  github: { getStars: vi.fn(async () => 42) },
  localFs: {
    getRoots: vi.fn(() => ({ home: '/home/scientist', machineName: 'Lab' })),
    listDir: vi.fn(async (path: string) => ({ entries: [], truncated: false, resolvedPath: path })),
    openPath: vi.fn(async () => ''),
    readPreview: vi.fn(async () => ({
      content: 'result',
      encoding: 'utf8' as const,
      size: 6,
      truncated: false
    })),
    revealInFolder: vi.fn(() => undefined)
  },
  folderGrants: {
    grant: vi.fn(async () => ({
      rootId: 'root-1',
      rootPath: '/data',
      label: 'data',
      createdAt: 1
    })),
    list: vi.fn(async () => ({ grants: [] })),
    revoke: vi.fn(async () => true)
  },
  logs: {
    getPath: vi.fn(() => '/logs/main.log'),
    openFile: vi.fn(async () => ({ opened: true })),
    revealInFolder: vi.fn(() => ({ revealed: true }))
  },
  notifications: {
    peekPendingOpenSession: vi.fn(() => ({ sessionId: 'session-1', token: 7 })),
    takePendingOpenSession: vi.fn(() => ({ sessionId: 'session-1', token: 7 }))
  },
  remoteAccess: {
    snapshot: vi.fn(() => remoteSnapshot),
    detect: vi.fn(async () => remoteSnapshot),
    setMode: vi.fn(async () => remoteSnapshot),
    disable: vi.fn(async () => remoteSnapshot),
    approve: vi.fn(async () => remoteSnapshot),
    reject: vi.fn(() => remoteSnapshot),
    revoke: vi.fn(async () => remoteSnapshot)
  } as unknown as HostApplicationCommandDependencies['remoteAccess'],
  reviewer: {
    run: vi.fn(async () => ({ started: true })),
    getForSession: vi.fn(async () => []),
    abortFixLoop: vi.fn(() => undefined),
    getChecklist: vi.fn(async () => ({ projectId: 'p', sessionId: 's', items: [] })),
    mutateChecklist: vi.fn(async () => undefined),
    getChunks: vi.fn(async () => [])
  },
  routine: {
    listAll: vi.fn(async () => []),
    upsert: vi.fn(async (_sessionId: string, configure: RoutineConfigureRequest) => ({
      id: 'routine-1',
      sessionId: _sessionId,
      label: configure.label,
      instruction: configure.instruction,
      everyMinutes: configure.everyMinutes,
      enabled: true,
      nextDue: Date.now(),
      lastFireAt: null,
      lastOkAt: null,
      tickCount: 0,
      missedTicks: 0,
      idleStreak: 0,
      pausedReason: null,
      lastResults: [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    })),
    remove: vi.fn(async () => true),
    setEnabled: vi.fn(async () => null)
  },
  endpoint: {
    listAll: vi.fn(async () => []),
    register: vi.fn(
      async (_sessionId: string, request: EndpointRegisterRequest): Promise<{
        endpoint: ManagedEndpoint
        newlyApproved: boolean
      }> => ({
        endpoint: {
          name: request.name,
          url: request.url,
          port: 20001,
          skillName: request.skillName,
          startScript: request.startScript,
          stopScript: request.stopScript,
          livePath: request.livePath,
          approvedScriptHash: 'hash',
          state: 'stopped',
          stateChangedAt: Date.now(),
          lastError: null,
          transcript: null,
          createdAt: Date.now(),
          updatedAt: Date.now()
        },
        newlyApproved: true
      })
    ),
    approve: vi.fn(async () => true),
    start: vi.fn(
      async (): Promise<ManagedEndpoint> => ({
        name: 'esm',
        url: 'http://127.0.0.1:20001',
        port: 20001,
        skillName: 's',
        startScript: 's',
        stopScript: 's',
        livePath: '/health',
        approvedScriptHash: 'hash',
        state: 'live',
        stateChangedAt: Date.now(),
        lastError: null,
        transcript: null,
        createdAt: Date.now(),
        updatedAt: Date.now()
      })
    ),
    stop: vi.fn(
      async (): Promise<ManagedEndpoint> => ({
        name: 'esm',
        url: 'http://127.0.0.1:20001',
        port: 20001,
        skillName: 's',
        startScript: 's',
        stopScript: 's',
        livePath: '/health',
        approvedScriptHash: 'hash',
        state: 'stopped',
        stateChangedAt: Date.now(),
        lastError: null,
        transcript: null,
        createdAt: Date.now(),
        updatedAt: Date.now()
      })
    ),
    remove: vi.fn(async () => true)
  },
  annotation: {
    set: vi.fn(
      async (_projectId: string, request: AnnotationSetRequest): Promise<{
        annotation: FileAnnotation
        replaced: boolean
      }> => ({
        annotation: {
          id: 'ann-1',
          projectId: _projectId,
          targetKind: 'file',
          targetKey: request.target,
          label: request.label,
          contentChecksum: request.fileSha256 ?? null,
          note: request.note,
          createdBy: 'user',
          createdAt: Date.now(),
          updatedAt: Date.now()
        },
        replaced: false
      })
    ),
    list: vi.fn(async () => []),
    remove: vi.fn(async () => true)
  },
  pdf: {
    open: vi.fn(async (_projectId: string, path: string): Promise<PdfOpenResult> => ({
      doc: { docId: 'doc-1', title: path, pageCount: 3, outline: [] },
      textPageCount: 3,
      emptyPageCount: 0
    })),
    pages: vi.fn(async (): Promise<PdfPagesResult> => ({
      docId: 'doc-1',
      start: 1,
      end: 1,
      pages: [{ page: 1, text: 'page one' }]
    })),
    outline: vi.fn(async (): Promise<PdfOutlineResult> => ({
      docId: 'doc-1',
      title: 'doc',
      pageCount: 3,
      outline: [{ title: 'Intro', page: 1, level: 1 }]
    })),
    scan: vi.fn(async (): Promise<PdfScanResult> => ({
      docId: 'doc-1',
      query: 'query',
      hits: [{ page: 2, score: 1, snippet: 'hit' }]
    }))
  },
  storage: {
    getInfo: vi.fn(async () => ({
      dataRoot: '/data',
      isDefault: true,
      defaultDataRoot: '/data',
      defaultParent: '/',
      dataRootMissing: false,
      legacyDataMovePrompt: false,
      usage: { categories: [], totalBytes: 0 },
      availableBytes: 100
    })),
    revealAppStorage: vi.fn(async () => ({ revealed: true })),
    detectActive: vi.fn(() => []),
    pickDirectory: vi.fn(async () => '/data-parent'),
    validateDataRoot: vi.fn(async () => ({ ok: true as const })),
    inspectDataRoot: vi.fn(async () => ({
      kind: 'move' as const,
      dataRoot: '/target/PureScience'
    })),
    migrate: vi.fn(async () => ({ ok: true as const })),
    setDataRootAndRelaunch: vi.fn(async () => ({ ok: true as const })),
    cancelMigrate: vi.fn(() => undefined),
    commitAndRelaunch: vi.fn(async () => ({ ok: true as const })),
    discardMigratedCopy: vi.fn(async () => undefined),
    dismissLegacyMovePrompt: vi.fn(async () => undefined)
  },
  update: {
    getAppInfo: vi.fn(() => ({ name: 'PureScience', version: '1.0.0', copyright: 'Zerolink' })),
    getStatus: vi.fn(() => updateStatus),
    check: vi.fn(async () => updateStatus),
    download: vi.fn(async () => updateStatus),
    cancel: vi.fn(async () => updateStatus),
    apply: vi.fn(async () => updateStatus)
  }
})

const invocation = <Args extends readonly unknown[]>(
  args: Args,
  callerContext: CallerContext = createElectronCallerContext(7)
): ApplicationInvocation<Args> => {
  const callerLease: ApplicationCallerLease = Object.freeze({
    leaseId: callerContext.leaseId,
    generation: 1,
    signal: new AbortController().signal,
    isCurrent: () => true
  })
  return Object.freeze({ args, callerContext, callerLease })
}

const commandByName = (name: string): ApplicationCommand<string, readonly unknown[], unknown> => {
  for (const { commands } of hostApplicationCommandGroups) {
    const command = (
      commands as readonly ApplicationCommand<string, readonly unknown[], unknown>[]
    ).find((candidate) => candidate.name === name)
    if (command) return command
  }
  throw new Error(`Missing host command: ${name}`)
}

describe('Host application commands', () => {
  it('defines the exact 46 request channels in their existing capability groups', () => {
    const expected = RENDERER_CONTRACT_GROUPS.filter(({ capability }) =>
      HOST_CAPABILITIES.includes(capability as (typeof HOST_CAPABILITIES)[number])
    ).map(({ capability, contracts }) => ({
      capability,
      channels: contracts
        .filter(
          ({ kind, surfaceInstallation }) =>
            kind === 'method' && surfaceInstallation.localWeb === 'web-rpc'
        )
        .map(({ channel }) => channel)
        .filter((channel): channel is string => channel !== null)
    }))

    expect(expected.flatMap(({ channels }) => channels)).toHaveLength(65)
    const actualGroups = hostApplicationCommandGroups
      .map(({ name, commands }) => ({
        capability: name,
        channels: commands.map(({ name: commandName }) => commandName)
      }))
      .sort((a, b) => a.capability.localeCompare(b.capability))
    const expectedGroups = [...expected].sort((a, b) => a.capability.localeCompare(b.capability))
    expect(actualGroups).toEqual(expectedGroups)
  })

  it('installs and uninstalls every host group atomically', () => {
    const router = createApplicationCommandRouter()
    const installation = registerHostApplicationCommands(
      router.registrar,
      {} as HostApplicationCommandDependencies
    )

    expect(router.dispatcher.commandNames()).toHaveLength(65)
    installation.uninstall()
    expect(router.dispatcher.commandNames()).toEqual([])
  })

  it('delegates every canonical argument tuple to the existing capability owner', async () => {
    const dependencies = createDependencies()
    const router = createApplicationCommandRouter()
    registerHostApplicationCommands(router.registrar, dependencies)
    const previewRequest = { path: '/data/result.txt', encoding: 'utf8' as const }
    const reviewRun = {
      sessionId: 'session-1',
      turnMessageId: 'message-1',
      projectId: 'project-1',
      origin: 'manual' as const
    }
    const reviewSession = { projectId: 'project-1', appSessionId: 'session-1' }
    const routineConfigure = {
      everyMinutes: 60,
      instruction: 'Check for new variants.'
    }
    const endpointRegisterRequest = {
      name: 'esm',
      url: 'http://127.0.0.1:20001',
      skillName: 'esm-runbook',
      startScript: 'docker inspect esm && docker start esm || docker run -d -p $HOST_PORT:80 esm',
      stopScript: 'docker stop esm',
      livePath: '/v1/models'
    }
    const annotationRequest = {
      target: 'src/main.ts',
      label: 'todo' as const,
      note: 'Refactor the parsing loop.'
    }
    const parent = { parent: '/target' }
    const pdfPath = '/data/paper.pdf'
    const root = { parent: '/target', markOnboarding: true }

    await router.dispatcher.invoke(hostApplicationCommands.cli.getStatus, invocation([]))
    await router.dispatcher.invoke(hostApplicationCommands.cli.install, invocation([]))
    await router.dispatcher.invoke(hostApplicationCommands.cli.uninstall, invocation([]))
    await router.dispatcher.invoke(hostApplicationCommands.github.getStars, invocation([]))
    await router.dispatcher.invoke(hostApplicationCommands.localFs.getRoots, invocation([]))
    await router.dispatcher.invoke(hostApplicationCommands.localFs.listDir, invocation(['/data']))
    await router.dispatcher.invoke(
      hostApplicationCommands.localFs.openPath,
      invocation(['/data/a'])
    )
    await router.dispatcher.invoke(
      hostApplicationCommands.localFs.readPreview,
      invocation([previewRequest])
    )
    await router.dispatcher.invoke(hostApplicationCommands.localFs.reveal, invocation(['/data/a']))
    await router.dispatcher.invoke(hostApplicationCommands.logs.getPath, invocation([]))
    await router.dispatcher.invoke(hostApplicationCommands.logs.openFile, invocation([]))
    await router.dispatcher.invoke(hostApplicationCommands.logs.revealInFolder, invocation([]))
    await router.dispatcher.invoke(
      hostApplicationCommands.notifications.peekPendingOpenSession,
      invocation([])
    )
    await router.dispatcher.invoke(
      hostApplicationCommands.notifications.takePendingOpenSession,
      invocation([7])
    )
    await router.dispatcher.invoke(
      hostApplicationCommands.remoteAccess.approve,
      invocation([{ requestId: 'pair-1', decision: 'once' }])
    )
    await router.dispatcher.invoke(hostApplicationCommands.remoteAccess.detect, invocation([]))
    await router.dispatcher.invoke(hostApplicationCommands.remoteAccess.disable, invocation([]))
    await router.dispatcher.invoke(hostApplicationCommands.remoteAccess.getSnapshot, invocation([]))
    await router.dispatcher.invoke(
      hostApplicationCommands.remoteAccess.reject,
      invocation([{ requestId: 'pair-2' }])
    )
    await router.dispatcher.invoke(
      hostApplicationCommands.remoteAccess.revokeBrowser,
      invocation([{ browserId: 'browser-1' }])
    )
    await router.dispatcher.invoke(
      hostApplicationCommands.remoteAccess.setMode,
      invocation([{ mode: 'remoteit' }])
    )
    await router.dispatcher.invoke(
      hostApplicationCommands.reviewer.abortFixLoop,
      invocation([reviewSession])
    )
    await router.dispatcher.invoke(
      hostApplicationCommands.reviewer.getChecklist,
      invocation([reviewSession])
    )
    await router.dispatcher.invoke(
      hostApplicationCommands.reviewer.getForSession,
      invocation([reviewSession])
    )
    await router.dispatcher.invoke(
      hostApplicationCommands.reviewer.mutateChecklist,
      invocation([{ ...reviewSession, rootFindingId: 'finding-1', resolution: 'resolved' }])
    )
    await router.dispatcher.invoke(
      hostApplicationCommands.reviewer.getChunks,
      invocation([reviewSession])
    )
    await router.dispatcher.invoke(hostApplicationCommands.reviewer.run, invocation([reviewRun]))
    await router.dispatcher.invoke(hostApplicationCommands.routine.listAll, invocation([]))
    await router.dispatcher.invoke(
      hostApplicationCommands.routine.upsert,
      invocation([{ sessionId: 'session-1', configure: routineConfigure }])
    )
    await router.dispatcher.invoke(
      hostApplicationCommands.routine.remove,
      invocation([{ sessionId: 'session-1', routineId: 'routine-1' }])
    )
    await router.dispatcher.invoke(
      hostApplicationCommands.routine.setEnabled,
      invocation([{ sessionId: 'session-1', routineId: 'routine-1', enabled: false }])
    )
    await router.dispatcher.invoke(hostApplicationCommands.endpoint.listAll, invocation([]))
    await router.dispatcher.invoke(
      hostApplicationCommands.endpoint.register,
      invocation([{ sessionId: 'session-1', request: endpointRegisterRequest }])
    )
    await router.dispatcher.invoke(
      hostApplicationCommands.endpoint.approve,
      invocation(['esm'])
    )
    await router.dispatcher.invoke(hostApplicationCommands.endpoint.start, invocation(['esm']))
    await router.dispatcher.invoke(hostApplicationCommands.endpoint.stop, invocation(['esm']))
    await router.dispatcher.invoke(hostApplicationCommands.endpoint.remove, invocation(['esm']))
    await router.dispatcher.invoke(
      hostApplicationCommands.annotation.set,
      invocation([{ projectId: 'project-1', request: annotationRequest }])
    )
    await router.dispatcher.invoke(
      hostApplicationCommands.annotation.list,
      invocation([{ projectId: 'project-1', target: 'src/main.ts' }])
    )
    await router.dispatcher.invoke(
      hostApplicationCommands.annotation.remove,
      invocation([{ projectId: 'project-1', annotationId: 'ann-1' }])
    )
    await router.dispatcher.invoke(
      hostApplicationCommands.pdf.open,
      invocation([{ projectId: 'project-1', path: pdfPath }])
    )
    await router.dispatcher.invoke(
      hostApplicationCommands.pdf.pages,
      invocation([{ projectId: 'project-1', docId: 'doc-1', start: 1, end: 2 }])
    )
    await router.dispatcher.invoke(
      hostApplicationCommands.pdf.outline,
      invocation([{ projectId: 'project-1', docId: 'doc-1' }])
    )
    await router.dispatcher.invoke(
      hostApplicationCommands.pdf.scan,
      invocation([{ projectId: 'project-1', docId: 'doc-1', query: 'attention' }])
    )
    await router.dispatcher.invoke(hostApplicationCommands.storage.cancelMigrate, invocation([]))
    await router.dispatcher.invoke(
      hostApplicationCommands.storage.commitAndRelaunch,
      invocation([parent])
    )
    await router.dispatcher.invoke(hostApplicationCommands.storage.detectActive, invocation([]))
    await router.dispatcher.invoke(
      hostApplicationCommands.storage.discardMigratedCopy,
      invocation([parent])
    )
    await router.dispatcher.invoke(
      hostApplicationCommands.storage.dismissLegacyMovePrompt,
      invocation([])
    )
    await router.dispatcher.invoke(hostApplicationCommands.storage.getInfo, invocation([]))
    await router.dispatcher.invoke(
      hostApplicationCommands.storage.inspectDataRoot,
      invocation([parent])
    )
    await router.dispatcher.invoke(hostApplicationCommands.storage.migrate, invocation([parent]))
    await router.dispatcher.invoke(hostApplicationCommands.storage.pickDirectory, invocation([]))
    await router.dispatcher.invoke(hostApplicationCommands.storage.revealAppStorage, invocation([]))
    await router.dispatcher.invoke(
      hostApplicationCommands.storage.setDataRootAndRelaunch,
      invocation([root])
    )
    await router.dispatcher.invoke(
      hostApplicationCommands.storage.validateDataRoot,
      invocation([parent])
    )
    await router.dispatcher.invoke(hostApplicationCommands.update.apply, invocation([]))
    await router.dispatcher.invoke(hostApplicationCommands.update.cancel, invocation([]))
    await router.dispatcher.invoke(hostApplicationCommands.update.check, invocation([]))
    await router.dispatcher.invoke(hostApplicationCommands.update.download, invocation([]))
    await router.dispatcher.invoke(hostApplicationCommands.update.getAppInfo, invocation([]))
    await router.dispatcher.invoke(hostApplicationCommands.update.getStatus, invocation([]))
    await router.dispatcher.invoke(
      hostApplicationCommands.folderGrants.grant,
      invocation([{ path: '/data' }])
    )
    await router.dispatcher.invoke(hostApplicationCommands.folderGrants.list, invocation([]))
    await router.dispatcher.invoke(
      hostApplicationCommands.folderGrants.revoke,
      invocation([{ rootId: 'root-1' }])
    )

    expect(dependencies.folderGrants.grant).toHaveBeenCalledWith('/data')
    expect(dependencies.folderGrants.list).toHaveBeenCalled()
    expect(dependencies.folderGrants.revoke).toHaveBeenCalledWith('root-1')
    expect(dependencies.localFs.listDir).toHaveBeenCalledWith('/data')
    expect(dependencies.localFs.readPreview).toHaveBeenCalledWith(previewRequest)
    expect(dependencies.notifications.takePendingOpenSession).toHaveBeenCalledWith(7)
    expect(dependencies.remoteAccess.approve).toHaveBeenCalledWith(
      { requestId: 'pair-1', decision: 'once' },
      true,
      true
    )
    expect(dependencies.remoteAccess.reject).toHaveBeenCalledWith('pair-2', true, true)
    expect(dependencies.remoteAccess.revoke).toHaveBeenCalledWith('browser-1', true, true)
    expect(dependencies.remoteAccess.setMode).toHaveBeenCalledWith('remoteit')
    expect(dependencies.reviewer.run).toHaveBeenCalledWith(reviewRun)
    expect(dependencies.reviewer.getForSession).toHaveBeenCalledWith(reviewSession)
    expect(dependencies.reviewer.getChecklist).toHaveBeenCalledWith(reviewSession)
    expect(dependencies.reviewer.mutateChecklist).toHaveBeenCalledWith({
      ...reviewSession,
      rootFindingId: 'finding-1',
      resolution: 'resolved'
    })
    expect(dependencies.reviewer.getChunks).toHaveBeenCalledWith(reviewSession)
    expect(dependencies.routine.listAll).toHaveBeenCalledWith()
    expect(dependencies.routine.upsert).toHaveBeenCalledWith('session-1', routineConfigure)
    expect(dependencies.routine.remove).toHaveBeenCalledWith('session-1', 'routine-1')
    expect(dependencies.routine.setEnabled).toHaveBeenCalledWith('session-1', 'routine-1', false)
    expect(dependencies.endpoint.listAll).toHaveBeenCalledWith()
    expect(dependencies.endpoint.register).toHaveBeenCalledWith('session-1', endpointRegisterRequest)
    expect(dependencies.endpoint.approve).toHaveBeenCalledWith('esm')
    expect(dependencies.endpoint.start).toHaveBeenCalledWith('esm')
    expect(dependencies.endpoint.stop).toHaveBeenCalledWith('esm')
    expect(dependencies.endpoint.remove).toHaveBeenCalledWith('esm')
    expect(dependencies.annotation.set).toHaveBeenCalledWith('project-1', annotationRequest)
    expect(dependencies.annotation.list).toHaveBeenCalledWith('project-1', 'src/main.ts')
    expect(dependencies.annotation.remove).toHaveBeenCalledWith('project-1', 'ann-1')
    expect(dependencies.pdf.open).toHaveBeenCalledWith('project-1', pdfPath)
    expect(dependencies.pdf.pages).toHaveBeenCalledWith('project-1', 'doc-1', 1, 2)
    expect(dependencies.pdf.outline).toHaveBeenCalledWith('project-1', 'doc-1')
    expect(dependencies.pdf.scan).toHaveBeenCalledWith('project-1', 'doc-1', 'attention')
    expect(dependencies.storage.commitAndRelaunch).toHaveBeenCalledWith(parent)
    expect(dependencies.storage.setDataRootAndRelaunch).toHaveBeenCalledWith(root)

    const ownerMethods = Object.values(dependencies).flatMap((owner) => Object.values(owner))
    expect(
      ownerMethods.filter(vi.isMockFunction).every((method) => method.mock.calls.length === 1)
    ).toBe(true)
  })

  it('rejects the exact local-only host inventory before entering an owner', async () => {
    const dependencies = createDependencies()
    const router = createApplicationCommandRouter()
    registerHostApplicationCommands(router.registrar, dependencies)
    const remoteCaller = createWebCallerContext('remote-browser', { location: 'remote' })
    const previewRequest = { path: '/data/result.txt', encoding: 'utf8' as const }
    const parent = { parent: '/target' }
    const annotationRequest = {
      target: 'src/main.ts',
      label: 'todo' as const,
      note: 'Refactor the parsing loop.'
    }
    const argsByChannel: Readonly<Record<string, readonly unknown[]>> = {
      'local-fs:list-dir': ['/data'],
      'local-fs:open-path': ['/data/result.txt'],
      'local-fs:read-preview': [previewRequest],
      'local-fs:reveal': ['/data/result.txt'],
      'storage:commit-and-relaunch': [parent],
      'storage:discard-migrated-copy': [parent],
      'storage:inspect-data-root': [parent],
      'storage:migrate': [parent],
      'storage:set-data-root-and-relaunch': [{ ...parent, markOnboarding: true }],
      'storage:validate-data-root': [parent],
      'endpoint:approve': ['esm'],
      'endpoint:register': [{ sessionId: 'session-1', request: { name: 'esm', url: 'http://127.0.0.1:20001', skillName: 'esm-runbook', startScript: 's', stopScript: 's', livePath: '/v1/models' } }],
      'endpoint:start': ['esm'],
      'endpoint:stop': ['esm'],
      'endpoint:remove': ['esm'],
      'endpoint:list-all': [],
      'annotation:set': [{ projectId: 'project-1', request: annotationRequest }],
      'annotation:list': [{ projectId: 'project-1', target: 'src/main.ts' }],
      'annotation:remove': [{ projectId: 'project-1', annotationId: 'ann-1' }],
      'pdf:open': [{ projectId: 'project-1', path: '/data/paper.pdf' }],
      'pdf:pages': [{ projectId: 'project-1', docId: 'doc-1', start: 1 }],
      'pdf:outline': [{ projectId: 'project-1', docId: 'doc-1' }],
      'pdf:scan': [{ projectId: 'project-1', docId: 'doc-1', query: 'x' }]
    }
    const localOnlyChannels = RENDERER_CONTRACT_GROUPS.filter(({ capability }) =>
      HOST_CAPABILITIES.includes(capability as (typeof HOST_CAPABILITIES)[number])
    ).flatMap(({ contracts }) =>
      contracts
        .filter(
          ({ surfaceInstallation }) =>
            surfaceInstallation.localWeb === 'web-rpc' &&
            surfaceInstallation.remoteWeb === 'rejecting-stub'
        )
        .map(({ channel }) => channel)
        .filter((channel): channel is string => channel !== null)
    )

    expect(localOnlyChannels).toHaveLength(38)
    for (const channel of localOnlyChannels) {
      await expect(
        router.dispatcher.invoke(
          commandByName(channel),
          invocation(argsByChannel[channel] ?? [], remoteCaller)
        )
      ).rejects.toThrow(`Channel only available from the local app: ${channel}`)
    }

    const ownerMethods = Object.values(dependencies).flatMap((owner) => Object.values(owner))
    expect(
      ownerMethods.filter(vi.isMockFunction).every((method) => method.mock.calls.length === 0)
    ).toBe(true)
  })

  it('preserves the five-state Remote Access authority and freshness matrix', async () => {
    const dependencies = createDependencies()
    const router = createApplicationCommandRouter()
    registerHostApplicationCommands(router.registrar, dependencies)
    const desktop = createElectronCallerContext(7)
    const localWeb = createWebCallerContext('local-web')
    const ordinaryRemote = createWebCallerContext('ordinary-remote', { location: 'remote' })
    const currentManager = createWebCallerContext('pairing-manager', {
      location: 'remote',
      authorities: ['manage-remote-pairing']
    })
    const staleManager = createWebCallerContext('stale-manager', {
      location: 'remote',
      authorities: ['manage-remote-pairing'],
      isAuthorizationCurrent: () => false
    })

    for (const caller of [desktop, localWeb, ordinaryRemote, currentManager]) {
      await router.dispatcher.invoke(
        hostApplicationCommands.remoteAccess.getSnapshot,
        invocation([], caller)
      )
    }
    await expect(
      router.dispatcher.invoke(
        hostApplicationCommands.remoteAccess.getSnapshot,
        invocation([], staleManager)
      )
    ).rejects.toThrow('Caller authorization is no longer current.')

    expect(dependencies.remoteAccess.snapshot).toHaveBeenNthCalledWith(1, true, true)
    expect(dependencies.remoteAccess.snapshot).toHaveBeenNthCalledWith(2, false, false)
    expect(dependencies.remoteAccess.snapshot).toHaveBeenNthCalledWith(3, false, false)
    expect(dependencies.remoteAccess.snapshot).toHaveBeenNthCalledWith(4, false, true)

    const approval = { requestId: 'pair-1', decision: 'once' as const }
    await expect(
      router.dispatcher.invoke(
        hostApplicationCommands.remoteAccess.approve,
        invocation([approval], ordinaryRemote)
      )
    ).rejects.toThrow(
      'Pairing can only be managed from the PureScience desktop app or an approved browser.'
    )
    await expect(
      router.dispatcher.invoke(
        hostApplicationCommands.remoteAccess.approve,
        invocation([approval], currentManager)
      )
    ).resolves.toBe(remoteSnapshot)
    expect(dependencies.remoteAccess.approve).toHaveBeenCalledWith(approval, false, true)

    await expect(
      router.dispatcher.invoke(
        hostApplicationCommands.remoteAccess.detect,
        invocation([], currentManager)
      )
    ).rejects.toThrow('This action must be approved from the PureScience desktop app.')
    expect(dependencies.remoteAccess.detect).not.toHaveBeenCalled()
  })

  it('keeps pending-notification token validation ahead of owner mutation', async () => {
    const dependencies = createDependencies()
    const router = createApplicationCommandRouter()
    registerHostApplicationCommands(router.registrar, dependencies)

    for (const invalidToken of ['7', 0, -1, 1.5, Number.POSITIVE_INFINITY]) {
      await expect(
        router.dispatcher.invoke(
          hostApplicationCommands.notifications.takePendingOpenSession,
          invocation([invalidToken])
        )
      ).resolves.toBeNull()
    }
    expect(dependencies.notifications.takePendingOpenSession).not.toHaveBeenCalled()

    await expect(
      router.dispatcher.invoke(
        hostApplicationCommands.notifications.takePendingOpenSession,
        invocation([7])
      )
    ).resolves.toEqual({ sessionId: 'session-1', token: 7 })
    expect(dependencies.notifications.takePendingOpenSession).toHaveBeenCalledWith(7)
  })
})
