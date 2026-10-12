import type { ConnectorApprovalRequest } from './settings'

type SaveBlobFileRequest = {
  suggestedName: string
  mimeType: string
  /** Raw file bytes from the renderer process. */
  data: ArrayBuffer
  /**
   * Present when the bytes were produced by an app action that has to be approved before they leave the
   * app (structure-view exports). The handler asks the approval card FIRST and writes nothing when it is
   * refused. Absent for every ordinary save ⇒ unchanged behaviour, no extra dialog.
   */
  approval?: NonNullable<ConnectorApprovalRequest['appAction']>
}

type SaveBlobFileResult = {
  saved: boolean
  filePath?: string
  /** Why nothing was written. `approval-denied` means the user refused at the approval card. */
  refused?: 'approval-denied'
}

type SaveManagedFileRequest = {
  source: 'artifact' | 'upload' | 'notebook-input' | 'local'
  path: string
  suggestedName: string
}

type SaveManagedFileResult = SaveBlobFileResult

type SaveSessionArtifactFile = {
  path: string
  suggestedName: string
}

type SaveSessionArtifactsRequest = {
  projectId: string
  sessionId: string
  files: SaveSessionArtifactFile[]
}

type SaveSessionArtifactFailure = SaveSessionArtifactFile & {
  message: string
}

type SaveSessionArtifactsResult =
  { saved: false } | { saved: true; filePaths: string[]; failures?: SaveSessionArtifactFailure[] }

export type {
  SaveBlobFileRequest,
  SaveBlobFileResult,
  SaveManagedFileRequest,
  SaveManagedFileResult,
  SaveSessionArtifactFailure,
  SaveSessionArtifactFile,
  SaveSessionArtifactsRequest,
  SaveSessionArtifactsResult
}
