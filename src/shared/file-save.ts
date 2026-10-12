import type { ConnectorApprovalRequest } from './settings'
import type { PngProvenanceText } from './image-metadata'

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
  /**
   * 这张图要**带着自己的事实**离开应用：这块区域的名字与指纹写进 PNG 的文本块（见 image-metadata 的
   * 「另一半」）。缺省 ⇒ 一个字节都不动（普通保存完全不受影响）。
   */
  imageFacts?: readonly PngProvenanceText[]
}

type SaveBlobFileResult = {
  saved: boolean
  filePath?: string
  /** Why nothing was written. `approval-denied` means the user refused at the approval card. */
  refused?: 'approval-denied'
  /**
   * 只在这张图**要求**带事实时出现：事实是否真的写进了文件。
   * `false` 时导出**照样成功**（文件是好的），但调用方必须如实说「这段区域的事实没能写进文件」，
   * 不许把「我以为写了」说成「文件里有」。
   */
  factsEmbedded?: boolean
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
