import type {
  FolderGrant,
  FolderGrantRequest,
  FolderGrantRevokeRequest,
  FolderGrantsSnapshot
} from '../shared/folder-grants'
import {
  FOLDER_GRANTS_CHANNEL_GRANT,
  FOLDER_GRANTS_CHANNEL_LIST,
  FOLDER_GRANTS_CHANNEL_REVOKE
} from '../shared/folder-grants'
import { ipcMainHandle } from './ipc-handler-registry'
import { FolderGrantsService } from './folder-grants'

// Registers the folder-grants IPC handlers (`@path/to/folder` linked folders) against a service
// instance. Injectable service for tests; defaults to a service rooted at the data root.
export const registerFolderGrantsIpcHandlers = (service: FolderGrantsService): void => {
  ipcMainHandle(FOLDER_GRANTS_CHANNEL_LIST, (): Promise<FolderGrantsSnapshot> => service.list())
  ipcMainHandle(
    FOLDER_GRANTS_CHANNEL_GRANT,
    (_event, request: FolderGrantRequest): Promise<FolderGrant> => service.grant(request.path)
  )
  ipcMainHandle(
    FOLDER_GRANTS_CHANNEL_REVOKE,
    (_event, request: FolderGrantRevokeRequest): Promise<boolean> => service.revoke(request.rootId)
  )
}
