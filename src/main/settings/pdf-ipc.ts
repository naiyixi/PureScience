// PDF-explore IPC handlers: the renderer's surface for layered PDF reading (used by future UI;
// the agent-facing pdf_* tools go through the RPC gateway). All parsing + persistence lives in
// the main-process PdfService (single writer).

import { ipcMainHandle } from '../ipc-handler-registry'
import type { PdfService } from './pdf-service'
import type {
  PdfFiguresResult,
  PdfOpenResult,
  PdfOutlineResult,
  PdfPagesResult,
  PdfScanResult,
  PdfTablesResult
} from '../../shared/pdf'

export const PDF_IPC = {
  OPEN: 'pdf:open',
  PAGES: 'pdf:pages',
  OUTLINE: 'pdf:outline',
  SCAN: 'pdf:scan',
  TABLES: 'pdf:tables',
  FIGURES: 'pdf:figures'
} as const

export type PdfCommandOwner = {
  open: (projectId: string, path: string) => Promise<PdfOpenResult>
  pages: (projectId: string, docId: string, start: number, end?: number) => Promise<PdfPagesResult>
  outline: (projectId: string, docId: string) => Promise<PdfOutlineResult>
  scan: (projectId: string, docId: string, query: string) => Promise<PdfScanResult>
  tables: (projectId: string, docId: string, page?: number) => Promise<PdfTablesResult>
  figures: (projectId: string, docId: string, page?: number) => Promise<PdfFiguresResult>
}

export const createPdfCommandOwner = (service: PdfService): PdfCommandOwner => ({
  open: (projectId, path) => service.open(path, projectId),
  pages: (_projectId, docId, start, end) => service.pages(docId, start, end),
  outline: (_projectId, docId) => service.outline(docId),
  scan: (_projectId, docId, query) => service.scan(docId, query),
  tables: (_projectId, docId, page) => service.tables(docId, page),
  figures: (_projectId, docId, page) => service.figures(docId, page)
})

export const registerPdfIpcHandlers = (owner: PdfCommandOwner): PdfCommandOwner => {
  ipcMainHandle(PDF_IPC.OPEN, (_event, request: { projectId: string; path: string }) =>
    owner.open(request.projectId, request.path)
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
  return owner
}

export type {
  PdfFiguresResult,
  PdfOpenResult,
  PdfOutlineResult,
  PdfPagesResult,
  PdfScanResult,
  PdfTablesResult
}
