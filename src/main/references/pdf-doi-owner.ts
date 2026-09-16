import type { CreateReferenceInput } from '../../shared/references'
import { importReferencesFromPdfText, type PdfDoiImportResult } from './pdf-doi-import'

// Composes the pieces the app already has: the PDF service reads a document's page text, the
// references service resolves an identifier and writes a record. Nothing here re-implements either —
// this file exists so the command surface (and, later, the library UI) share one import path.
export type PdfDocumentPorts = {
  /** Registers/opens the document for a project and reports its page count, so scanning is bounded. */
  open: (path: string, projectId: string) => Promise<{ docId: string; pageCount: number }>
  /** Text of a page range, in order. */
  pages: (docId: string, start: number, end: number) => Promise<string>
}

export type ReferenceResolutionPorts = {
  resolveByIdentifier: (
    kind: 'doi',
    identifier: string,
    projectId: string
  ) => Promise<CreateReferenceInput | undefined>
  addReference: (
    input: CreateReferenceInput
  ) => Promise<{ status: 'created' | 'duplicate'; referenceId: string }>
}

/** How many pages are scanned for identifiers. Citations live on the first pages or the reference list. */
export const MAX_PAGES_SCANNED = 12

export type PdfDoiImportOwner = {
  importFromPdf: (
    projectId: string,
    pdfPath: string,
    options?: { limit?: number }
  ) => Promise<PdfDoiImportResult>
}

export const createPdfDoiImportOwner = (deps: {
  pdf: PdfDocumentPorts
  references: ReferenceResolutionPorts
}): PdfDoiImportOwner => ({
  /**
   * Imports the references a PDF cites. Resolution failures and the per-document cap are reported by
   * the result rather than thrown, so one dead identifier cannot abort an otherwise useful import.
   */
  importFromPdf: async (
    projectId: string,
    pdfPath: string,
    options: { limit?: number } = {}
  ): Promise<PdfDoiImportResult> => {
    const document = await deps.pdf.open(pdfPath, projectId)
    const lastPage = Math.max(1, Math.min(document.pageCount, MAX_PAGES_SCANNED))

    return importReferencesFromPdfText(
      {
        readText: () => deps.pdf.pages(document.docId, 1, lastPage),
        resolve: (doi) => deps.references.resolveByIdentifier('doi', doi, projectId),
        add: (input) => deps.references.addReference(input)
      },
      options
    )
  }
})
