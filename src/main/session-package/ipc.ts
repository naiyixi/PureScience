import { BrowserWindow, dialog } from 'electron'
import { readFile } from 'node:fs/promises'

import { SESSION_PACKAGE_EXTENSION } from '../../shared/session-package'
import type {
  SessionPackageImportPreview,
  SessionPackageImportRequest
} from '../../shared/session-package-import'
import { ipcMainHandle } from '../ipc-handler-registry'
import { inspectSessionPackage } from './import'
import type { SessionPackageImportOwner } from './import-owner'
import { createSessionPackageOwner, type SessionPackageOwnerDeps } from './owner'
import { importSessionPackage, type SessionPackageImportDeps } from './import-session'

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

// The import half of the desktop surface. Preview never writes: it reads the archive, reports what it
// holds and what it refuses, and leaves the choice to a second, explicit call.
export type SessionPackageImportIpcDeps = {
  owner: SessionPackageImportOwner
  /** Chooses a package with the OS dialog. Absent where no dialog can exist. */
  showOpenDialog?: (window?: BrowserWindow) => Promise<string | null>
}

const readPackageFile = async (path: string): Promise<Uint8Array> =>
  new Uint8Array(await readFile(path))

export const registerSessionPackageImportIpcHandlers = (
  deps: SessionPackageImportIpcDeps
): void => {
  ipcMainHandle(
    'sessions:preview-package',
    async (event, request: { packagePath?: string } | undefined) => {
      const window = BrowserWindow.fromWebContents(event.sender) ?? undefined
      let packagePath = request?.packagePath
      if (!packagePath) {
        // `null` means the user closed the picker; that is not a refusal of a package.
        packagePath = (await deps.showOpenDialog?.(window)) ?? undefined
        if (!packagePath) return null
      }
      const bytes = await readPackageFile(packagePath).catch(() => undefined)
      if (!bytes)
        return { accepted: false, reason: 'not-a-package' } satisfies SessionPackageImportPreview
      return inspectSessionPackage(bytes)
    }
  )

  ipcMainHandle('sessions:import-package', (_event, request: SessionPackageImportRequest) =>
    importSessionPackage(
      deps.owner.ports(readPackageFile) satisfies SessionPackageImportDeps,
      request
    )
  )
}
