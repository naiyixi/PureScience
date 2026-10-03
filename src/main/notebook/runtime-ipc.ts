import { dialog } from 'electron'

import { ipcMainHandle } from '../ipc-handler-registry'

import type { NotebookLanguage } from '../../shared/notebook'
import type { ImportLockRequest, NamedEnvironmentRequest } from '../../shared/notebook-env'
import type { RuntimeSelection } from '../../shared/notebook-runtime'
import { broadcastNotebookEnvProgress } from './env-ipc'
import type { RuntimeSelectionWorkflows } from './runtime-selection-workflows'

export type RuntimeIpcOptions = {
  // Injectable for tests; production defaults to the Electron native open-file dialog.
  showOpenDialog?: () => Promise<string | null>
}

// Registers renderer-callable runtime-selection commands while keeping native host interaction in
// the Electron adapter. Application ordering and state ownership live behind the workflow interface.
const registerRuntimeIpcHandlers = (
  workflows: RuntimeSelectionWorkflows,
  options: RuntimeIpcOptions = {}
): void => {
  ipcMainHandle('runtime:survey', () => workflows.survey())

  ipcMainHandle('runtime:list-environments', () => workflows.listEnvironments())

  ipcMainHandle(
    'runtime:list-packages',
    (_event, request: { language: NotebookLanguage; envId: string }) =>
      workflows.listPackages(request)
  )

  ipcMainHandle('runtime:list-package-counts', (_event, request: { language: NotebookLanguage }) =>
    workflows.listPackageCounts(request)
  )

  ipcMainHandle(
    'runtime:set-selection',
    (_event, request: { language: NotebookLanguage; selection: RuntimeSelection | null }) =>
      workflows.setSelection(request)
  )

  ipcMainHandle('runtime:get-enablement', (_event, request: { language: NotebookLanguage }) =>
    workflows.getEnablement(request)
  )

  ipcMainHandle(
    'runtime:describe-usage',
    (_event, request: { language: NotebookLanguage; envId: string }) =>
      workflows.describeUsage(request)
  )

  ipcMainHandle(
    'runtime:set-environment-enabled',
    (
      _event,
      request: { language: NotebookLanguage; envId: string; enabled: boolean; force?: boolean }
    ) => workflows.setEnvironmentEnabled(request)
  )

  ipcMainHandle(
    'runtime:set-install-authorized',
    (_event, request: { language: NotebookLanguage; envId: string; authorized: boolean }) =>
      workflows.setInstallAuthorized(request)
  )

  ipcMainHandle('runtime:pick-interpreter', async (): Promise<string | null> => {
    try {
      if (options.showOpenDialog) return await options.showOpenDialog()
      const result = await dialog.showOpenDialog({ properties: ['openFile'] })
      return result.filePaths[0] ?? null
    } catch (err) {
      // Never let a picker failure surface as a raw rejection to the renderer; the choose action
      // becomes a no-op instead.
      console.error('[runtime-ipc] pick-interpreter failed', err)
      return null
    }
  })

  ipcMainHandle(
    'runtime:register-interpreter',
    (_event, request: { language: NotebookLanguage; path: string }) => workflows.register(request)
  )

  ipcMainHandle(
    'runtime:unregister-interpreter',
    (_event, request: { language: NotebookLanguage; path: string }) => workflows.unregister(request)
  )

  // A7 external-lock import. Progress is broadcast on the EXISTING notebook-env:progress event with a
  // distinct `phase` the store routes into its own slot (never the per-language provisioning cards).
  ipcMainHandle('runtime:import-lock', (_event, request: ImportLockRequest) =>
    workflows.importLock(request, (progress) => broadcastNotebookEnvProgress(progress))
  )

  // Audit P0-8: the named environments (the set notebooks select from) and removal of one — the surface
  // an external-lock import used to be a dead end without.
  ipcMainHandle('runtime:manage-named-environments', (_event, request: NamedEnvironmentRequest) =>
    workflows.manageNamedEnvironments(request)
  )
}

export { registerRuntimeIpcHandlers }
