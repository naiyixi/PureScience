// PDF-explore IPC handlers: the renderer's surface for layered PDF reading (used by future UI;
// the agent-facing pdf_* tools go through the RPC gateway). All parsing + persistence lives in
// the main-process PdfService (single writer).

import { ipcMainHandle } from '../ipc-handler-registry'
import type { PdfService } from './pdf-service'
import type {
  PdfOpenResult,
  PdfOutlineResult,
  PdfPagesResult,
  PdfScanResult
} from '../../shared/pdf'

export const PDF_IPC = {
  OPEN: 'pdf:open',
  PAGES: 'pdf:pages',
  OUTLINE: 'pdf:outline',
  SCAN: 'pdf:scan'
} as const

export type PdfCommandOwner = {
  open: (projectId: string, path: string) => Promise<PdfOpenResult>
  pages: (projectId: string, docId: string, start: number, end?: number) => Promise<PdfPagesResult>
  outline: (projectId: string, docId: string) => Promise<PdfOutlineResult>
  scan: (projectId: string, docId: string, query: string) => Promise<PdfScanResult>
}

export const createPdfCommandOwner = (service: PdfService): PdfCommandOwner => ({
  open: (projectId, path) => service.open(path, projectId),
  pages: (_projectId, docId, start, end) => service.pages(docId, start, end),
  outline: (_projectId, docId) => service.outline(docId),
  scan: (_projectId, docId, query) => service.scan(docId, query)
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
  return owner
}

export type { PdfOpenResult, PdfOutlineResult, PdfPagesResult, PdfScanResult }
