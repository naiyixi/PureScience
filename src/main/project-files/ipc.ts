import { ipcMainHandle } from '../ipc-handler-registry'
import { createLogger } from '../logger'

import type {
  ArtifactGroupPage,
  GetProjectFilesOverviewRequest,
  ListArtifactGroupsRequest,
  ListProjectFileKindsRequest,
  ListProjectFilesRequest,
  ProjectFileKindsSummary,
  ProjectFilesOverview,
  ProjectFilesPage,
  SearchArtifactsRequest,
  SearchArtifactsResult
} from '../../shared/project-files'

type ProjectFilesQueryRepository = {
  getOverview(request: GetProjectFilesOverviewRequest): Promise<ProjectFilesOverview>
  listFiles(request: ListProjectFilesRequest): Promise<ProjectFilesPage>
  listKinds(request: ListProjectFileKindsRequest): Promise<ProjectFileKindsSummary[]>
  listArtifactGroups(request: ListArtifactGroupsRequest): Promise<ArtifactGroupPage>
  searchArtifacts(request: SearchArtifactsRequest): Promise<SearchArtifactsResult>
}

type ProjectFilesRepairBackend = {
  repairProjectFiles(projectId: string): Promise<void>
}

type ProjectFilesRecoveryBackend = {
  recoverPendingDeletions(): Promise<void>
}

// Every Files read waits on the project-deletion recovery gate before touching the index, so the cost of a
// Files interaction is (gate + query) and nothing said which half it was. The UI showed it plainly: the
// Home page asks each project for its files, ~50 of them, and each call measured ~120 ms in main. Reported
// only when a read is slow, and carrying no request contents.
const SLOW_FILES_READ_THRESHOLD_MS = 50
const filesLog = createLogger('project-files')

const timedRead = async <Result>(
  operation: string,
  recovery: ProjectFilesRecoveryBackend,
  read: () => Promise<Result>
): Promise<Result> => {
  const startedAt = Date.now()
  try {
    await recovery.recoverPendingDeletions()
  } catch (error) {
    // Failing closed here is the existing contract; the diagnostic must not change it.
    filesLog.warn('project files read could not pass the recovery gate', {
      operation,
      durationMs: Date.now() - startedAt,
      outcome: 'rejected'
    })
    throw error
  }
  const recoveryMs = Date.now() - startedAt
  const result = await read()
  const totalMs = Date.now() - startedAt
  if (totalMs >= SLOW_FILES_READ_THRESHOLD_MS) {
    try {
      filesLog.warn('project files read was slow', {
        operation,
        totalMs,
        recoveryMs,
        queryMs: totalMs - recoveryMs
      })
    } catch {
      // Best-effort only: a diagnostic must never replace the read result.
    }
  }
  return result
}

type ProjectFilesHandlers = {
  getOverview(request: GetProjectFilesOverviewRequest): Promise<ProjectFilesOverview>
  listFiles(request: ListProjectFilesRequest): Promise<ProjectFilesPage>
  listKinds(request: ListProjectFileKindsRequest): Promise<ProjectFileKindsSummary[]>
  listArtifactGroups(request: ListArtifactGroupsRequest): Promise<ArtifactGroupPage>
  searchArtifacts(request: SearchArtifactsRequest): Promise<SearchArtifactsResult>
  repairIndex(request: { projectId: string }): Promise<void>
}

// Keep recovery waiting inside the testable handler layer so direct IPC registration cannot bypass the
// sticky deletion gate for reads or repair.
const createProjectFilesHandlers = (
  repository: ProjectFilesQueryRepository,
  repairBackend: ProjectFilesRepairBackend,
  recoveryBackend: ProjectFilesRecoveryBackend
): ProjectFilesHandlers => ({
  getOverview: (request) =>
    timedRead('getOverview', recoveryBackend, () => repository.getOverview(request)),
  listFiles: (request) =>
    timedRead('listFiles', recoveryBackend, () => repository.listFiles(request)),
  // The Home page reads one kind list per project; batching it is what keeps that fan-out off the shared
  // engine queue, so this read goes through the same recovery gate and the same slow-read instrument.
  listKinds: (request) =>
    timedRead('listKinds', recoveryBackend, () => repository.listKinds(request)),
  listArtifactGroups: (request) =>
    timedRead('listArtifactGroups', recoveryBackend, () => repository.listArtifactGroups(request)),
  searchArtifacts: (request) =>
    timedRead('searchArtifacts', recoveryBackend, () => repository.searchArtifacts(request)),
  repairIndex: async ({ projectId }) => {
    await recoveryBackend.recoverPendingDeletions()
    return repairBackend.repairProjectFiles(projectId)
  }
})

// All Files operations wait on the same project-deletion recovery gate before reading or repairing
// metadata. This prevents a query from observing rows midway through crash recovery.
const registerProjectFilesIpcHandlers = (
  repository: ProjectFilesQueryRepository,
  repairBackend: ProjectFilesRepairBackend,
  recoveryBackend: ProjectFilesRecoveryBackend,
  handlers: ProjectFilesHandlers = createProjectFilesHandlers(
    repository,
    repairBackend,
    recoveryBackend
  )
): void => {
  ipcMainHandle('project-files:get-overview', (_event, request: GetProjectFilesOverviewRequest) =>
    handlers.getOverview(request)
  )
  ipcMainHandle('project-files:list-files', (_event, request: ListProjectFilesRequest) =>
    handlers.listFiles(request)
  )
  ipcMainHandle('project-files:list-kinds', (_event, request: ListProjectFileKindsRequest) =>
    handlers.listKinds(request)
  )
  ipcMainHandle(
    'project-files:list-artifact-groups',
    (_event, request: ListArtifactGroupsRequest) => handlers.listArtifactGroups(request)
  )
  ipcMainHandle('project-files:search-artifacts', (_event, request: SearchArtifactsRequest) =>
    handlers.searchArtifacts(request)
  )
  ipcMainHandle('project-files:repair-index', (_event, request: { projectId: string }) =>
    handlers.repairIndex(request)
  )
}

export { createProjectFilesHandlers, registerProjectFilesIpcHandlers }
export type {
  ProjectFilesHandlers,
  ProjectFilesQueryRepository,
  ProjectFilesRecoveryBackend,
  ProjectFilesRepairBackend
}
