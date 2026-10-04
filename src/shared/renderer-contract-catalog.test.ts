import { describe, expect, it } from 'vitest'

import { WEB_EVENT_CHANNELS, WEB_INVOKE_CHANNELS } from './web-api-map.generated'
import { RENDERER_CONTRACT_CATALOG, RENDERER_CONTRACT_GROUPS } from './renderer-contract-catalog'
import { projectRendererContractMaps } from './renderer-contract'

const paths = (
  predicate: (contract: (typeof RENDERER_CONTRACT_CATALOG)[number]) => boolean
): string[] => RENDERER_CONTRACT_CATALOG.filter(predicate).map(({ publicPath }) => publicPath)

describe('renderer contract catalog', () => {
  it('pins the complete capability-owned inventory and legacy map projection', () => {
    const projection = projectRendererContractMaps(RENDERER_CONTRACT_CATALOG)

    // 46 groups / 449 contracts with the RO-Crate export (roCrate.exportProject): one desktop-only
    // channel, so no Web projection and no local-Web installation move with it.
    // 45 groups / 448 contracts with the PDF annotation surface (pdfAnnotations.create /
    // exportAnnotated / exportNotes / import / list / reattach / remove): seven local-only channels
    // beside the PDF reading surface they belong to.
    // 453 with the journal metric import (references.importJournalMetrics): a library write channel like the
    // other references commands, so it installs on the window and both Web surfaces and no other count moves.
    // 456 with the external-lock import (runtime.importLock, A7): a LOCAL runtime channel, so the catalog,
    // the invoke map and the local-Web installation set each move by one while the remote-Web one grows by
    // the rejecting stub it gets for being local-only.
    // 457 with the named-environment surface (runtime.manageNamedEnvironments, audit P0-8): same profile
    // as the import above, so the same three counts move again.
    // 458 with the artifact reveal handoff (artifacts:reveal-file, IC9): a LOCAL artifact channel, so the
    // catalog, the invoke map and the local-Web installation set each move by one while the remote-Web one
    // grows by the rejecting stub it gets for being local-only.
    // 460 with the window package install/uninstall (runtime.manage-packages, IC13): another LOCAL
    // runtime channel, so the catalog, the preload inventory and the local-Web installation set each
    // move by one while the remote-Web one grows by the rejecting stub it gets for being local-only.
    expect(RENDERER_CONTRACT_GROUPS).toHaveLength(46)
    // 463 with the window's session runtime binding surface (notebook.listRuntimes / bindRuntime /
    // switchRuntime, IC14): three plain Web request channels, so the catalog, the invoke map and the
    // local-Web installation set each move by three while the remote-Web set grows by the same three.
    expect(RENDERER_CONTRACT_CATALOG).toHaveLength(464)
    expect(projection.invoke).toEqual(WEB_INVOKE_CHANNELS)
    expect(projection.event).toEqual(WEB_EVENT_CHANNELS)
    // 344 with the PDF annotation export channels (pdfAnnotations.exportAnnotated / exportNotes):
    // both are local-only invoke channels, so the invoke map and the local-only set move together.
    // 354 with the window package install/uninstall (runtime.manage-packages, IC13): same profile.
    // 357 with the session runtime binding surface (IC14): three more local invoke channels.
    expect(Object.keys(projection.invoke)).toHaveLength(358)
    expect(Object.keys(projection.event)).toHaveLength(34)
  })

  it('separates actual Web installation from the generated compatibility projection', () => {
    // 378 with the journal metric import (references.importJournalMetrics), a plain Web request profile.
    // 383 with the artifact reveal handoff (artifacts:reveal-file, IC9), a LOCAL artifact channel.
    // 384 with the window package install/uninstall (runtime.manage-packages, IC13), same profile.
    // 387 with the session runtime binding surface (notebook.*, IC14): three plain Web request channels.
    expect(
      paths(({ surfaceInstallation }) => surfaceInstallation.localWeb !== 'unavailable')
    ).toHaveLength(388)
    expect(
      paths(({ surfaceInstallation }) => surfaceInstallation.localWeb === 'browser-native')
    ).toEqual(['getRuntimeVersions', 'saveBlobFile', 'saveManagedFile', 'window.close'])
    expect(
      RENDERER_CONTRACT_CATALOG.filter(({ publicPath }) =>
        ['saveBlobFile', 'window.close'].includes(publicPath)
      ).every(
        ({ dispatchPolicy, authorityFlow }) =>
          dispatchPolicy.electron === 'electron-ipc-request' &&
          dispatchPolicy.localWeb === 'surface-native' &&
          authorityFlow.electron === 'electron-sender'
      )
    ).toBe(true)
    expect(
      RENDERER_CONTRACT_CATALOG.find(({ publicPath }) => publicPath === 'saveManagedFile')
    ).toMatchObject({
      dispatchPolicy: {
        electron: 'electron-ipc-request',
        localWeb: 'browser-native-with-direct-application-request',
        remoteWeb: 'browser-native-with-direct-application-request'
      },
      authorityFlow: {
        electron: 'electron-sender',
        localWeb: 'caller-context',
        remoteWeb: 'caller-context'
      }
    })
    expect(
      paths(({ surfaceInstallation }) => surfaceInstallation.localWeb === 'unavailable')
    ).toHaveLength(76)
    expect(
      paths(({ surfaceInstallation }) => surfaceInstallation.remoteWeb === 'rejecting-stub')
    ).toHaveLength(123)
    expect(
      paths(({ eventDeliverability }) =>
        Object.values(eventDeliverability).includes('installed-undelivered')
      )
    ).toEqual([
      'notebookEnv.onProgress',
      'notifications.onOpenSession',
      'notifications.onViewProbe',
      'uploads.onTransferProgress',
      'window.onCloseActivePane'
    ])
  })

  it('records every intentional and known-deviating argument codec without normalizing it', () => {
    expect(
      RENDERER_CONTRACT_CATALOG.find(({ publicPath }) => publicPath === 'uploads.stageLocalFile')
        ?.parameterCodec
    ).toEqual({ electron: 'native-file-upload-request', web: 'native-file-upload-request' })

    expect(
      RENDERER_CONTRACT_CATALOG.filter(({ publicPath }) =>
        ['acp.connect', 'acp.createSession'].includes(publicPath)
      ).map(({ publicPath, parameterCodec }) => ({ publicPath, parameterCodec }))
    ).toEqual([
      {
        publicPath: 'acp.connect',
        parameterCodec: {
          electron: 'default-empty-object',
          web: 'default-empty-object-absent-only'
        }
      },
      {
        publicPath: 'acp.createSession',
        parameterCodec: {
          electron: 'default-empty-object',
          web: 'default-empty-object-absent-only'
        }
      }
    ])

    expect(
      RENDERER_CONTRACT_CATALOG.find(({ publicPath }) => publicPath === 'notebookEnv.cancel')
        ?.parameterCodec
    ).toEqual({ electron: 'optional-argument-slot', web: 'positional' })

    expect(
      paths(
        ({ parameterCodec, surfaceInstallation }) =>
          surfaceInstallation.localWeb === 'web-rpc' &&
          parameterCodec.electron !== parameterCodec.web
      )
    ).toEqual([
      'acp.connect',
      'acp.createSession',
      'notebookEnv.cancel',
      'runtime.describeUsage',
      'runtime.getEnablement',
      'runtime.listPackageCounts',
      'runtime.listPackages',
      'runtime.registerInterpreter',
      'runtime.setEnvironmentEnabled',
      'runtime.setInstallAuthorized',
      'runtime.setSelection',
      'runtime.unregisterInterpreter',
      'sessions.saveSession'
    ])

    const explicitEquivalentTransforms = paths(
      ({ parameterCodec }) =>
        parameterCodec.electron === parameterCodec.web &&
        parameterCodec.web !== 'positional' &&
        parameterCodec.web !== 'event-listener' &&
        parameterCodec.web !== 'surface-native'
    )
    expect(explicitEquivalentTransforms).toEqual([
      'storage.commitAndRelaunch',
      'storage.discardMigratedCopy',
      'storage.inspectDataRoot',
      'storage.migrate',
      'storage.setDataRootAndRelaunch',
      'storage.validateDataRoot',
      'uploads.stageLocalFile'
    ])
  })

  it('preserves Specialist, Permission, and Compute surface asymmetry', () => {
    const specialist = RENDERER_CONTRACT_CATALOG.filter(({ publicPath }) =>
      publicPath.startsWith('specialist.')
    )
    expect(specialist).toHaveLength(31)
    expect(
      specialist.every(
        ({ surfaceInstallation }) =>
          surfaceInstallation.localWeb === 'unavailable' &&
          surfaceInstallation.remoteWeb === 'unavailable'
      )
    ).toBe(true)

    const permissionPaths = [
      'acp.respondToPermission',
      'acp.revokePermissionGrant',
      'acp.setPermissionProfile',
      'permissions.extendUndo',
      'permissions.list',
      'permissions.restore',
      'permissions.restoreDefaults',
      'permissions.revoke'
    ]
    expect(
      RENDERER_CONTRACT_CATALOG.filter(({ publicPath }) =>
        permissionPaths.includes(publicPath)
      ).every(
        ({ surfaceInstallation, authorityFlow }) =>
          surfaceInstallation.remoteWeb === 'web-rpc' &&
          authorityFlow.remoteWeb === 'caller-context'
      )
    ).toBe(true)

    const compute = RENDERER_CONTRACT_CATALOG.filter(({ publicPath }) =>
      publicPath.startsWith('compute.')
    )
    expect(compute).toHaveLength(25)
    expect(
      compute
        .filter(({ surfaceInstallation }) => surfaceInstallation.remoteWeb === 'rejecting-stub')
        .map(({ publicPath }) => publicPath)
    ).toEqual(['compute.download', 'compute.revealInFolder'])
  })

  it('records the paired window lifecycle channels and teardown ordering', () => {
    const lifecycleFor = (publicPath: string): unknown =>
      RENDERER_CONTRACT_CATALOG.find((contract) => contract.publicPath === publicPath)
        ?.lifecycleDispatch

    expect(lifecycleFor('window.onCloseActivePane')).toEqual({
      activateChannel: 'shortcut:close-active-pane-ready',
      activate: 'after-subscribe',
      deactivateChannel: 'shortcut:close-active-pane-unready',
      deactivate: 'after-unsubscribe'
    })
    expect(lifecycleFor('window.announceWindowFindReady')).toEqual({
      activateChannel: 'shortcut:window-find-ready',
      activate: 'on-call',
      deactivateChannel: 'shortcut:window-find-unready',
      deactivate: 'on-dispose'
    })
  })
})
