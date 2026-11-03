// PDF-explore IPC handlers: the renderer's surface for layered PDF reading (used by future UI;
// the agent-facing pdf_* tools go through the RPC gateway). All parsing + persistence lives in
// the main-process PdfService (single writer).

import { ipcMainHandle } from '../ipc-handler-registry'
import type { PdfService } from './pdf-service'
import type { OcrRecogniseOutcome, OcrRecogniseRequest } from '../../shared/ocr'
import type {
  PdfFiguresResult,
  PdfOpenResult,
  PdfOutlineResult,
  PdfPagesResult,
  PdfScanResult,
  PdfTablesResult,
  PdfTranslationWindowRequest,
  PdfTranslationWindowResult
} from '../../shared/pdf'

export const PDF_IPC = {
  OPEN: 'pdf:open',
  PAGES: 'pdf:pages',
  OUTLINE: 'pdf:outline',
  SCAN: 'pdf:scan',
  TABLES: 'pdf:tables',
  FIGURES: 'pdf:figures',
  TRANSLATION: 'pdf:translation',
  // Reads text out of an image (a scan, a photographed figure) with the local tesseract. It sits in the PDF
  // group because it answers the same question the other channels do — what does this document say — for the
  // pages the text layer cannot answer.
  OCR: 'pdf:ocr'
} as const

/**
 * The window's translation entry. Its dependencies are not all the PDF service's (a model endpoint and a
 * checkpoint root are the composition site's), so the whole call is supplied there rather than composed out
 * of service methods here.
 */
export type PdfTranslationHandler = (
  projectId: string,
  request: PdfTranslationWindowRequest
) => Promise<PdfTranslationWindowResult>

export type PdfOcrHandler = (request: OcrRecogniseRequest) => Promise<OcrRecogniseOutcome>

export type PdfCommandOwnerOptions = {
  /**
   * Absent ⇒ the channel refuses by name. That is deliberate: a window command that silently answers
   * "nothing was translated" when nothing is wired would read as an empty document rather than as a
   * surface that was never connected.
   */
  translation?: PdfTranslationHandler
  /**
   * Absent for the same reason `translation` may be: the OCR service and the managed-path resolver are the
   * composition site's dependencies, not this service's. Absent ⇒ the channel refuses by name.
   */
  ocr?: PdfOcrHandler
}

export type PdfCommandOwner = {
  open: (projectId: string, path: string, sessionId?: string) => Promise<PdfOpenResult>
  pages: (projectId: string, docId: string, start: number, end?: number) => Promise<PdfPagesResult>
  outline: (projectId: string, docId: string) => Promise<PdfOutlineResult>
  scan: (projectId: string, docId: string, query: string) => Promise<PdfScanResult>
  tables: (projectId: string, docId: string, page?: number) => Promise<PdfTablesResult>
  figures: (projectId: string, docId: string, page?: number) => Promise<PdfFiguresResult>
  translation: (
    projectId: string,
    request: PdfTranslationWindowRequest
  ) => Promise<PdfTranslationWindowResult>
  ocr: (request: OcrRecogniseRequest) => Promise<OcrRecogniseOutcome>
}

export const createPdfCommandOwner = (
  service: PdfService,
  options: PdfCommandOwnerOptions = {}
): PdfCommandOwner => ({
  open: (projectId, path, sessionId) => service.open(path, projectId, sessionId),
  pages: (_projectId, docId, start, end) => service.pages(docId, start, end),
  outline: (_projectId, docId) => service.outline(docId),
  scan: (_projectId, docId, query) => service.scan(docId, query),
  tables: (_projectId, docId, page) => service.tables(docId, page),
  figures: (_projectId, docId, page) => service.figures(docId, page),
  translation: (projectId, request) => {
    const handler = options.translation
    if (!handler) throw new Error('pdf:translation is not configured.')
    return handler(projectId, request)
  },
  ocr: (request) => {
    const handler = options.ocr
    if (!handler) throw new Error('pdf:ocr is not configured.')
    return handler(request)
  }
})

export const registerPdfIpcHandlers = (owner: PdfCommandOwner): PdfCommandOwner => {
  ipcMainHandle(
    PDF_IPC.OPEN,
    (_event, request: { projectId: string; path: string; sessionId?: string }) =>
      owner.open(request.projectId, request.path, request.sessionId)
  )
  ipcMainHandle(
    PDF_IPC.PAGES,
    (_event, request: { projectId: string; docId: string; start: number; end?: number }) =>
      owner.pages(request.projectId, request.docId, request.start, request.end)
  )
  ipcMainHandle(PDF_IPC.OUTLINE, (_event, request: { projectId: string; docId: string }) =>
    owner.outline(request.projectId, request.docId)
  )
  ipcMainHandle(
    PDF_IPC.SCAN,
    (_event, request: { projectId: string; docId: string; query: string }) =>
      owner.scan(request.projectId, request.docId, request.query)
  )
  ipcMainHandle(
    PDF_IPC.TABLES,
    (_event, request: { projectId: string; docId: string; page?: number }) =>
      owner.tables(request.projectId, request.docId, request.page)
  )
  ipcMainHandle(
    PDF_IPC.FIGURES,
    (_event, request: { projectId: string; docId: string; page?: number }) =>
      owner.figures(request.projectId, request.docId, request.page)
  )
  ipcMainHandle(PDF_IPC.TRANSLATION, (_event, request: PdfTranslationWindowRequest) =>
    owner.translation(request.projectId, request)
  )
  ipcMainHandle(PDF_IPC.OCR, (_event, request: OcrRecogniseRequest) => owner.ocr(request))
  return owner
}

export type {
  PdfFiguresResult,
  PdfOpenResult,
  PdfOutlineResult,
  PdfPagesResult,
  PdfScanResult,
  PdfTablesResult,
  PdfTranslationWindowRequest,
  PdfTranslationWindowResult
}
