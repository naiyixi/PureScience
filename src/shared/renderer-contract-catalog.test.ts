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
    expect(RENDERER_CONTRACT_GROUPS).toHaveLength(50)
    // 463 with the window's session runtime binding surface (notebook.listRuntimes / bindRuntime /
    // switchRuntime, IC14): three plain Web request channels, so the catalog, the invoke map and the
    // local-Web installation set each move by three while the remote-Web set grows by the same three.
    // 471 with the message-centre reader deletions (notifications.clearAll /
    // notifications.deleteItems): two desktop-only channels, so the catalog and the preload inventory
    // move by two while neither Web map moves at all.
    // 472 with the skill fork (settings.forkImportedSkill, work order 二): a plain Web request channel,
    // so the catalog, the invoke map, the preload inventory and both Web installation sets move by one.
    // 473 with the read-only external crate inspection (roCrate.inspectExternal): a desktop-only channel,
    // so the catalog and the preload inventory move by one while neither Web map moves at all — and the
    // local-Web set below grows by the same one, for the same reason.
    // 474 with verifying a recorded reading (artifacts.verifyReading): a plain Web request channel, so the
    // catalog, the invoke map, the preload inventory and both Web installation sets move by one.
    // 475 with the on-demand duplicate sweep (storage.sweepDuplicateContent, P0-10): another LOCAL
    // storage channel, so the catalog, the preload inventory and the local-Web installation set each
    // move by one while the remote-Web set grows by the rejecting stub it gets for being local-only.
    // 476 with the remote-structure load (preview:load-remote-structure, LOCAL): the renderer names
    // only a PDB id, so it is local-only and never re-dispatched by a paired browser.
    // 477 with the window's PDF translation entry (pdf:translation, LOCAL): local-only, so the catalog,
    // the preload inventory and the local-Web installation set each move by one.
    // 478/479 with the plugin source read and its cancel (specialist.pluginSourcePreview /
    // specialist.pluginSourceCancel, LOCAL): the renderer asks for a reference and the main process does
    // the fetching, so they are local-only — the catalog, the preload inventory and the local-Web
    // installation set each move by two, while the remote-Web set grows by the rejecting stub a
    // local-only channel gets there.
    // 482 with the deployed-plugin catalogue (specialist.pluginCatalog): a desktop-only channel, so
    // the catalog and the preload inventory move by one and neither Web map moves at all.
    // 485 with the local parsing models (settings.getLocalParsingModels / downloadLocalParsingModel):
    // both are LOCAL Web commands, so the catalog, the invoke map and the local-Web installation set each
    // move by two while the remote-Web set grows by the rejecting stub each one gets there.
    // 487 with the citation mark (v2.6.0 A2: references.markCited / references.clearCited): two plain
    // Web request contracts, so the catalog, the invoke map and the local-Web set each move by two.
    // 494 with the knowledge copy sweep (knowledge.sweepCopies, LOCAL) and the inverse-folding pair
    // (engines.*): one and two desktop-only contracts, so the catalog and the preload inventory move by
    // three while the local-Web "unavailable" set moves with them.
    // 498 with the session run-data measurement (sessions:read-notebook-usage): one more capability-owned
    // request contract in the sessions group.
    // 500 with the citation walk (references.discover-citations): one more capability-owned request
    // contract in the references group.
    expect(RENDERER_CONTRACT_CATALOG).toHaveLength(502)
    expect(projection.invoke).toEqual(WEB_INVOKE_CHANNELS)
    expect(projection.event).toEqual(WEB_EVENT_CHANNELS)
    // 344 with the PDF annotation export channels (pdfAnnotations.exportAnnotated / exportNotes):
    // both are local-only invoke channels, so the invoke map and the local-only set move together.
    // 354 with the window package install/uninstall (runtime.manage-packages, IC13): same profile.
    // 357 with the session runtime binding surface (IC14): three more local invoke channels.
    // 366 with verifying a recorded reading (artifacts.verifyReading): a plain Web request channel, so the
    // invoke map and the local-only set move together.
    // 374 with the citation mark (v2.6.0 A2): the two reference-write channels, same profile as above.
    // 375 with the session run-data measurement (sessions:read-notebook-usage): one more invoke map entry.
    // 377 with the DOI integrity pair: both are invoke-map entries (the check is LOCAL-only, which the
    // remote rejection set reflects, not the map).
    // 378 with the citation walk (references:discover-citations): one more invoke-map entry.
    // 381 with the portable-session package (D1: sessions:exportPackage / sessions:importPackage): both are
    // LOCAL invoke channels, so the map grows by two while the remote surface gains two rejections.
    expect(Object.keys(projection.invoke)).toHaveLength(381)
    expect(Object.keys(projection.event)).toHaveLength(34)
  })

  it('separates actual Web installation from the generated compatibility projection', () => {
    // 378 with the journal metric import (references.importJournalMetrics), a plain Web request profile.
    // 383 with the artifact reveal handoff (artifacts:reveal-file, IC9), a LOCAL artifact channel.
    // 384 with the window package install/uninstall (runtime.manage-packages, IC13), same profile.
    // 387 with the session runtime binding surface (notebook.*, IC14): three plain Web request channels.
    // 388 with stopping a remote job (compute.jobsCancel, IC39): a LOCAL-only compute channel, so the
    // catalog, the invoke map and the local-Web installation set each move by one while the remote-Web
    // set grows by the rejecting stub it gets for being local-only.
    // 395 with the skill fork (settings.forkImportedSkill, work order 二): a plain Web request channel,
    // so the local-Web installation set moves with it while the remote-Web one gains the same channel.
    // 396 with verifying a recorded reading (artifacts.verifyReading): the same profile, one more method.
    // 404 with the citation mark (v2.6.0 A2): the two reference-write channels are callable on the
    // local Web surface, like the reference writes they sit beside.
    // 405 with the session run-data measurement (sessions:read-notebook-usage): a plain Web request
    // channel, callable on the local Web surface like the session reads it sits beside.
    // 407 with the citation walk (references.discoverCitations, LOCAL): installed on the local Web surface
    // like the integrity check it sits beside — LOCAL keeps it off the paired remote surface only.
    // 411 with the portable-session package (D1): two more methods installed on the local Web surface.
    expect(
      paths(({ surfaceInstallation }) => surfaceInstallation.localWeb !== 'unavailable')
    ).toHaveLength(411)
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
    // 78 before the plugin source channels; the two of them are local-only, so they join this set.
    // 83 with the deployed-plugin catalogue: it is unreachable from the Web surfaces too, so it joins
    // this one rather than a Web installation set.
    // 88 with the knowledge copy sweep: desktop-only, so the Web installation stays unavailable for it.
    // 94 would be wrong here: the citation walk (references.discover-citations, LOCAL) is installable on
    // the local Web surface, so it lands on the 409 side — only the paired remote set grows below.
    // 91 with the portable-session package (D1): both directions left this set when they became LOCAL.
    expect(
      paths(({ surfaceInstallation }) => surfaceInstallation.localWeb === 'unavailable')
    ).toHaveLength(91)
    // 133 with the citation walk: LOCAL earns the rejecting stub on the paired remote surface.
    // 135 with the portable-session package pair (D1), same reason.
    expect(
      paths(({ surfaceInstallation }) => surfaceInstallation.remoteWeb === 'rejecting-stub')
    ).toHaveLength(135)
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
    // 31 before the plugin source read and its cancel; both are specialist channels.
    // 36 with the deployed-plugin catalogue, which is a specialist channel like its siblings.
    expect(specialist).toHaveLength(36)
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
    expect(compute).toHaveLength(26)
    expect(
      compute
        .filter(({ surfaceInstallation }) => surfaceInstallation.remoteWeb === 'rejecting-stub')
        .map(({ publicPath }) => publicPath)
    ).toEqual(['compute.download', 'compute.jobsCancel', 'compute.revealInFolder'])
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
