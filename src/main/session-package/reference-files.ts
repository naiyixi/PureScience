import type { SessionPackageFile } from './export'
import { uniquePackagePath } from './files'

// The reference library's PDFs, on the same terms as the session's own files: injected storage, bounded
// bytes, unique package paths, and unreadable items named rather than dropped.
//
// They travel under their own manifest field instead of inside `files`, so a reader can still tell a
// session artifact from a paper the session cited.

export const REFERENCE_PACKAGE_DIR = 'references'

export type SessionPackageReferenceAttachment = {
  /** The library record this PDF belongs to, so the package stays traceable to the citation. */
  referenceId: string
  fileName: string
  bytes: Uint8Array
}

export type SessionPackageReferenceFilesDeps = {
  /**
   * The project's reference attachments. The app owns storage and applies the byte bound on read; this
   * module owns the naming and what a reader is told about what did not travel.
   */
  listReferenceAttachments: (request: { projectId: string; maxBytes: number }) => Promise<{
    attachments: readonly SessionPackageReferenceAttachment[]
    unreadable: readonly string[]
  }>
  /** How many PDFs the project has, without reading a byte (essential mode names the count). */
  countReferenceAttachments: (request: { projectId: string }) => Promise<number>
  /** Maximum bytes a single carried PDF may have. */
  maxFileBytes: number
}

export type SessionPackageReferenceFilesResult = {
  files: readonly SessionPackageFile[]
  unreadable: readonly string[]
}

export type SessionPackageReferenceFileLister = {
  countReferenceFiles: (request: { projectId: string }) => Promise<number>
  listReferenceFiles: (request: {
    projectId: string
  }) => Promise<SessionPackageReferenceFilesResult>
}

export const createSessionPackageReferenceFileLister = (
  deps: SessionPackageReferenceFilesDeps
): SessionPackageReferenceFileLister => {
  const usedNames = new Set<string>()

  const listReferenceFiles = async (request: {
    projectId: string
  }): Promise<SessionPackageReferenceFilesResult> => {
    const { attachments, unreadable } = await deps.listReferenceAttachments({
      projectId: request.projectId,
      maxBytes: deps.maxFileBytes
    })

    const files: SessionPackageFile[] = []
    const unreadableNames = [...unreadable]

    for (const attachment of attachments) {
      const packagePath = `${REFERENCE_PACKAGE_DIR}/${attachment.fileName}`
      if (attachment.bytes.byteLength > deps.maxFileBytes) {
        // Named, never silently dropped - and never written half.
        unreadableNames.push(packagePath)
        continue
      }
      // Two references can carry a PDF with the same file name; later ones get a stable suffix so they
      // neither overwrite each other nor disappear.
      const unique = uniquePackagePath(usedNames, attachment.fileName)
      files.push({ path: `${REFERENCE_PACKAGE_DIR}/${unique}`, contents: attachment.bytes })
    }

    return { files, unreadable: unreadableNames }
  }

  // Counting is free; reading is not. An essential package names how many it left behind.
  const countReferenceFiles = async (request: { projectId: string }): Promise<number> =>
    deps.countReferenceAttachments(request)

  return Object.freeze({ countReferenceFiles, listReferenceFiles })
}
