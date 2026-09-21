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

/**
 * The library's CURRENT attachment for a reference. It lives on the reference row itself:
 * `ReferenceAttachmentVersion` only ever records files that were SUPERSEDED, so a reader that asks the
 * history for the current one finds nothing at all. That is not hypothetical — a real session exported
 * a package carrying zero papers while every unit test stayed green, because the port's fixture handed
 * the attachment over directly and no test ever saw the real shape.
 *
 * Exported as the single place that maps a reference to a managed file, so the wiring and its tests
 * cannot disagree about where the current PDF lives.
 */
export const currentReferencePdfId = (reference: {
  pdfManagedFileId?: string | null
}): string | undefined => reference.pdfManagedFileId ?? undefined

export type SessionPackageReferenceLibraryReference = {
  id: string
  title?: string
  /** The reference row's own current PDF. `null`/absent means this record has no PDF attached. */
  pdfManagedFileId?: string | null
}

export type SessionPackageReferenceLibraryDeps = {
  /** The project's references, exactly as the library surface returns them. */
  listReferences: (projectId: string) => Promise<readonly SessionPackageReferenceLibraryReference[]>
  /** The managed bytes behind one project file; `null` when it cannot be read. */
  readManagedFileBytes: (projectId: string, managedFileId: string) => Promise<Uint8Array | null>
  maxFileBytes: number
}

export type SessionPackageReferenceLibrary = {
  listReferenceAttachments: (request: { projectId: string; maxBytes: number }) => Promise<{
    attachments: readonly SessionPackageReferenceAttachment[]
    unreadable: readonly string[]
  }>
  /** How many references have a PDF, without reading a byte. */
  countReferenceAttachments: (request: { projectId: string }) => Promise<number>
}

// The reference side of the export against real shapes: a reference row, a byte reader, and the naming
// a reader of the package ends up seeing.
export const createSessionPackageReferenceLibrary = (
  deps: SessionPackageReferenceLibraryDeps
): SessionPackageReferenceLibrary => {
  const safeName = (title: string | undefined, id: string): string => {
    const stem = (title?.trim() || id).replace(/[\\/:*?"<>|]/g, '_').slice(0, 80)
    return stem || id
  }

  const listReferenceAttachments = async (request: {
    projectId: string
    maxBytes: number
  }): Promise<{
    attachments: readonly SessionPackageReferenceAttachment[]
    unreadable: readonly string[]
  }> => {
    const references = await deps.listReferences(request.projectId)
    const attachments: SessionPackageReferenceAttachment[] = []
    const unreadable: string[] = []
    for (const reference of references) {
      const managedFileId = currentReferencePdfId(reference)
      if (!managedFileId) continue
      const fileName = `${safeName(reference.title, reference.id)}.pdf`
      const bytes = await deps.readManagedFileBytes(request.projectId, managedFileId)
      if (!bytes || bytes.byteLength > request.maxBytes) {
        // Named, never silently dropped, and never written half.
        unreadable.push(`${REFERENCE_PACKAGE_DIR}/${fileName}`)
        continue
      }
      attachments.push({ referenceId: reference.id, fileName, bytes })
    }
    return { attachments, unreadable }
  }

  // Counting is free; reading is not.
  const countReferenceAttachments = async (request: { projectId: string }): Promise<number> =>
    (await deps.listReferences(request.projectId)).filter((reference) =>
      Boolean(currentReferencePdfId(reference))
    ).length

  return Object.freeze({ listReferenceAttachments, countReferenceAttachments })
}
