import type { OcrRecogniseOutcome, OcrRecogniseRequest } from '../../shared/ocr'
import type { ManagedPreviewSource } from '../../shared/preview-resources'
import type { OcrService } from './ocr-service'

// The window asks for a file by the identity it already shows (source + path), never by an absolute path: the
// resolver injected here is the same one the file previews use, so OCR cannot be pointed at a path the reader
// could not already open.
export type ManagedPathResolver = (
  source: ManagedPreviewSource,
  request: { path: string; projectId?: string; sessionId?: string }
) => Promise<string>

export type OcrCommandOwner = {
  recognise: (request: OcrRecogniseRequest) => Promise<OcrRecogniseOutcome>
}

export const createOcrCommandOwner = (
  service: OcrService,
  resolvePath: ManagedPathResolver
): OcrCommandOwner => ({
  recognise: async (request) => {
    let absolute: string
    try {
      absolute = await resolvePath(request.source, {
        path: request.path,
        ...(request.projectId ? { projectId: request.projectId } : {}),
        ...(request.sessionId ? { sessionId: request.sessionId } : {})
      })
    } catch (error) {
      // A file the resolver refuses is not "no text found": it is a file this window may not read, and the
      // reader is told that instead of being shown an empty box.
      return {
        status: 'unreadable',
        message: error instanceof Error ? error.message : String(error)
      }
    }
    return service.recognise(absolute, request.uiLanguage)
  }
})
