import { BrowserWindow, dialog } from 'electron'

import { SESSION_PACKAGE_EXTENSION } from '../../shared/session-package'
import { ipcMainHandle } from '../ipc-handler-registry'
import { createSessionPackageOwner, type SessionPackageOwnerDeps } from './owner'

// The desktop side of the export. The dialog lives here, not in the owner, because only the adapter
// knows which window invoked the channel — and the sheet must belong to that window.
export type SessionPackageIpcDeps = Omit<SessionPackageOwnerDeps, 'showSaveDialog' | 'now'>

const saveDialogOptions = (suggestedFileName: string): Electron.SaveDialogOptions => ({
  title: 'Export session package',
  defaultPath: suggestedFileName,
  filters: [
    { name: 'PureScience session package', extensions: [SESSION_PACKAGE_EXTENSION.slice(1)] }
  ]
})

const registerSessionPackageIpcHandlers = (
  deps: SessionPackageIpcDeps,
  owner = createSessionPackageOwner(deps)
): void => {
  ipcMainHandle('sessions:export-package', (event, request) =>
    owner.exportPackage(request, {
      showSaveDialog: async (suggestedFileName) => {
        const window = BrowserWindow.fromWebContents(event.sender) ?? undefined
        const options = saveDialogOptions(suggestedFileName)
        const result = window
          ? await dialog.showSaveDialog(window, options)
          : await dialog.showSaveDialog(options)
        return result.canceled || !result.filePath ? null : result.filePath
      }
    })
  )
}

export { registerSessionPackageIpcHandlers }
