// Case bundle IPC handlers: the window's five channels for putting a case into a folder, taking one out of a folder,
// reading the shelf, installing from it, and publishing to it.
//
// These exist because the application command composition is not the desktop surface. A channel listed there is
// reachable from the Web view, the command line and the Task view; a window reaches it only through an `ipcMain`
// handler, and without this file every `cases:*` call in a real window answers "No handler registered" — which is
// exactly what the packaged certification lane caught: the home page reads the shelf on mount, so the throw landed in
// the window's own error channel and took the rest of the surface down with it.

import { ipcMainHandle } from '../ipc-handler-registry'
import type {
  CaseBundleExportRequest,
  CaseBundleImportRequest,
  CaseInstallRequest,
  CaseMarketplaceRequest
} from '../../shared/case-bundle'
import type { CasePublishRequest } from '../../shared/case-publish'

import type { CaseBundleCommandOwner } from './case-bundle-owner'

export const CASE_BUNDLE_IPC = {
  EXPORT: 'cases:export-bundle',
  IMPORT: 'cases:import-bundle',
  MARKETPLACE: 'cases:marketplace',
  INSTALL: 'cases:install',
  PUBLISH: 'cases:publish'
} as const

export const registerCaseBundleIpcHandlers = (
  owner: CaseBundleCommandOwner
): CaseBundleCommandOwner => {
  ipcMainHandle(CASE_BUNDLE_IPC.EXPORT, (_event, request: CaseBundleExportRequest) =>
    owner.export(request)
  )
  ipcMainHandle(CASE_BUNDLE_IPC.IMPORT, (_event, request: CaseBundleImportRequest) =>
    owner.import(request)
  )
  ipcMainHandle(CASE_BUNDLE_IPC.MARKETPLACE, (_event, request: CaseMarketplaceRequest) =>
    owner.marketplace(request)
  )
  ipcMainHandle(CASE_BUNDLE_IPC.INSTALL, (_event, request: CaseInstallRequest) =>
    owner.install(request)
  )
  ipcMainHandle(CASE_BUNDLE_IPC.PUBLISH, (_event, request: CasePublishRequest) =>
    owner.publish(request)
  )
  return owner
}
