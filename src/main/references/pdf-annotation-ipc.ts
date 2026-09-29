// PDF annotation IPC handlers (文档标注层 A3): the window's surface for the annotation layer on a PDF
// preview — list, create, remove, re-anchor, import.
//
// Everything goes through the main-process service, which is where the version authority lives: the
// window says which file VERSION it is looking at, and the checksum, the bytes and the anchor state are
// resolved here. There is no agent-facing counterpart: an annotation is the reader's own markup on their
// own file version, exactly like the session bookmarks beside it.

import { ipcMainHandle } from '../ipc-handler-registry'
import type {
  PdfAnnotationAnchorRequest,
  PdfAnnotationCreateRequest,
  PdfAnnotationImportOutcome,
  PdfAnnotationListResult,
  PdfAnnotationReattachRequest,
  PdfAnnotationReattachResult,
  PdfAnnotationRemoveRequest,
  PdfAnnotationRemoveResult
} from '../../shared/pdf-annotation-surface'
import type { PdfAnnotation } from '../../shared/pdf-annotations'
import type { PdfAnnotationService } from './pdf-annotation-service'

export const PDF_ANNOTATION_IPC = {
  CREATE: 'pdf-annotations:create',
  IMPORT: 'pdf-annotations:import',
  LIST: 'pdf-annotations:list',
  REATTACH: 'pdf-annotations:reattach',
  REMOVE: 'pdf-annotations:remove'
} as const

export type PdfAnnotationCommandOwner = {
  create: (request: PdfAnnotationCreateRequest) => Promise<PdfAnnotation>
  import: (request: PdfAnnotationAnchorRequest) => Promise<PdfAnnotationImportOutcome>
  list: (request: PdfAnnotationAnchorRequest) => Promise<PdfAnnotationListResult>
  reattach: (request: PdfAnnotationReattachRequest) => Promise<PdfAnnotationReattachResult>
  remove: (request: PdfAnnotationRemoveRequest) => Promise<PdfAnnotationRemoveResult>
}

export const createPdfAnnotationCommandOwner = (
  service: PdfAnnotationService
): PdfAnnotationCommandOwner => ({
  create: (request) => service.create(request),
  import: (request) => service.import(request),
  list: (request) => service.list(request),
  reattach: (request) => service.reattach(request),
  remove: (request) => service.remove(request)
})

export const registerPdfAnnotationIpcHandlers = (
  owner: PdfAnnotationCommandOwner
): PdfAnnotationCommandOwner => {
  ipcMainHandle(PDF_ANNOTATION_IPC.CREATE, (_event, request: PdfAnnotationCreateRequest) =>
    owner.create(request)
  )
  ipcMainHandle(PDF_ANNOTATION_IPC.IMPORT, (_event, request: PdfAnnotationAnchorRequest) =>
    owner.import(request)
  )
  ipcMainHandle(PDF_ANNOTATION_IPC.LIST, (_event, request: PdfAnnotationAnchorRequest) =>
    owner.list(request)
  )
  ipcMainHandle(PDF_ANNOTATION_IPC.REATTACH, (_event, request: PdfAnnotationReattachRequest) =>
    owner.reattach(request)
  )
  ipcMainHandle(PDF_ANNOTATION_IPC.REMOVE, (_event, request: PdfAnnotationRemoveRequest) =>
    owner.remove(request)
  )
  return owner
}

export type {
  PdfAnnotationAnchorRequest,
  PdfAnnotationCreateRequest,
  PdfAnnotationImportOutcome,
  PdfAnnotationListResult,
  PdfAnnotationReattachRequest,
  PdfAnnotationReattachResult,
  PdfAnnotationRemoveRequest,
  PdfAnnotationRemoveResult
}
