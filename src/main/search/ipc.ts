import { ipcMainHandle } from '../ipc-handler-registry'

import type { GlobalSearchRequest, GlobalSearchResponse } from '../../shared/global-search'
import type { SearchEvidenceRequest, SearchEvidenceResponse } from '../../shared/search-evidence'
import { createSearchHandlers, type SearchHandlerPorts, type SearchHandlers } from './handlers'

// Desktop surface for global search. The same handlers are registered as an application command so the
// web UI reaches them through the shared dispatcher; this file only owns the Electron invoke names.

const createSearchIpcHandlers = (ports: SearchHandlerPorts): SearchHandlers =>
  createSearchHandlers(ports)

const registerSearchIpcHandlers = (handlers: SearchHandlers): void => {
  ipcMainHandle(
    'search:query',
    (_event, request: GlobalSearchRequest): Promise<GlobalSearchResponse> => handlers.query(request)
  )
  ipcMainHandle(
    'search:evidence',
    (_event, request: SearchEvidenceRequest): Promise<SearchEvidenceResponse> =>
      handlers.evidence(request)
  )
}

export { createSearchIpcHandlers, registerSearchIpcHandlers }
export type { SearchHandlers }
