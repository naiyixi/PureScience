import { ipcMainHandle } from '../ipc-handler-registry'

import type {
  DeletePreviewStateRequest,
  LoadPreviewStateRequest,
  PersistedPreviewState,
  SavePreviewStateRequest
} from '../../shared/preview-state'
import type {
  CreateProjectRequest,
  DeleteProjectRequest,
  Project,
  ProjectDeletionOutcome,
  UpdateProjectArchiveRequest,
  UpdateProjectRequest
} from '../../shared/projects'
import { LIFECYCLE_CHANNELS } from '../../shared/lifecycle-events'
import { broadcastLifecycleEvent } from '../lifecycle-broadcast'
import type { ProjectDeletionCoordinator } from './deletion-coordinator'
import type { StructureRemoteLoadResult } from '../../shared/structure-remote-source'
import type { RemoteStructureRequest } from '../preview/remote-structure-loader'
import { PreviewStateRepository } from './preview-repository'
import { getProjectDbClient } from './prisma-client'
import { ProjectRepository } from './repository'
import { resolveStorageRoot } from '../storage-root'

type ProjectHandlers = {
  list: () => Promise<Project[]>
  get: (id: string) => Promise<Project | null>
  create: (request: CreateProjectRequest) => Promise<Project>
  update: (request: UpdateProjectRequest) => Promise<Project>
  updateArchive: (request: UpdateProjectArchiveRequest) => Promise<Project>
  // Resolves with what the deletion removed from disk, so the confirmation surface can report it.
  delete: (id: string) => Promise<ProjectDeletionOutcome>
}

// Production repositories backed by the SQLite database under the (dev-aware) storage root. The client is
// passed as a provider (not a resolved promise) so a failed first initialization can be retried on the
// next request instead of being cached for the app's lifetime.
const createDefaultProjectRepository = (): ProjectRepository =>
  new ProjectRepository(() => getProjectDbClient(resolveStorageRoot()))

const createDefaultPreviewStateRepository = (): PreviewStateRepository =>
  new PreviewStateRepository(() => getProjectDbClient(resolveStorageRoot()))

type ProjectDeleteHandler = Pick<
  ProjectDeletionCoordinator,
  'deleteProject' | 'recoverPendingDeletions'
>
type ProjectCrudRepository = Pick<ProjectRepository, 'list' | 'get' | 'create' | 'update'> &
  Partial<Pick<ProjectRepository, 'updateArchive'>>
type ProjectArchiveHandler = Pick<ProjectHandlers, 'updateArchive'>

// Adapts repository operations into thin handlers while enforcing one shared recovery gate. CRUD
// cannot observe or mutate projects until every durable deletion intent has finished replaying.
const createProjectHandlers = (
  repository: ProjectCrudRepository,
  deletionCoordinator: ProjectDeleteHandler,
  archiveHandler: ProjectArchiveHandler = {
    updateArchive: (request) => {
      if (!repository.updateArchive) throw new Error('Project archive is unavailable.')
      return repository.updateArchive(request, Date.now())
    }
  }
): ProjectHandlers => ({
  list: async () => {
    await deletionCoordinator.recoverPendingDeletions()
    return repository.list()
  },
  get: async (id) => {
    await deletionCoordinator.recoverPendingDeletions()
    return repository.get(id)
  },
  create: async (request) => {
    await deletionCoordinator.recoverPendingDeletions()
    return repository.create(request)
  },
  update: async (request) => {
    await deletionCoordinator.recoverPendingDeletions()
    return repository.update(request)
  },
  updateArchive: async (request) => {
    await deletionCoordinator.recoverPendingDeletions()
    return archiveHandler.updateArchive(request)
  },
  delete: async (id) => {
    await deletionCoordinator.recoverPendingDeletions()
    return deletionCoordinator.deleteProject(id)
  }
})

// Registers the renderer-callable project + per-project preview-state commands.
const registerProjectIpcHandlers = (
  repository: ProjectRepository,
  previewRepository: PreviewStateRepository,
  deletionCoordinator: ProjectDeleteHandler,
  handlers: ProjectHandlers = createProjectHandlers(repository, deletionCoordinator),
  // D6 第二半：远程结构加载（装配处提供 —— 它握有出网设置、保护级别、审批卡与会话工作区）。
  // 缺省时**照样注册**：让渲染端拿到一个具名拒绝，而不是运行期的「没有 handler」。
  loadRemoteStructure?: (request: RemoteStructureRequest) => Promise<StructureRemoteLoadResult>
): void => {
  ipcMainHandle('projects:list', () => handlers.list())
  ipcMainHandle('projects:get', (_event, id: string) => handlers.get(id))
  ipcMainHandle('projects:create', async (_event, request: CreateProjectRequest) => {
    const project = await handlers.create(request)
    broadcastLifecycleEvent(LIFECYCLE_CHANNELS.projectCreated, project)
    return project
  })
  ipcMainHandle('projects:update', async (_event, request: UpdateProjectRequest) => {
    const project = await handlers.update(request)
    broadcastLifecycleEvent(LIFECYCLE_CHANNELS.projectUpdated, project)
    return project
  })
  ipcMainHandle('projects:update-archive', async (_event, request: UpdateProjectArchiveRequest) => {
    const project = await handlers.updateArchive(request)
    broadcastLifecycleEvent(LIFECYCLE_CHANNELS.projectUpdated, project)
    return project
  })
  ipcMainHandle('projects:delete', async (_event, request: DeleteProjectRequest) => {
    const outcome = await handlers.delete(request.id)
    broadcastLifecycleEvent(LIFECYCLE_CHANNELS.projectDeleted, { projectId: request.id })
    return outcome
  })

  ipcMainHandle(
    'preview:load',
    (_event, request: LoadPreviewStateRequest): Promise<PersistedPreviewState | null> =>
      previewRepository.get(request.projectId)
  )
  ipcMainHandle('preview:save', (_event, request: SavePreviewStateRequest) =>
    previewRepository.save(request.projectId, request.state)
  )
  ipcMainHandle('preview:delete', (_event, request: DeletePreviewStateRequest) =>
    previewRepository.delete(request.projectId)
  )
  ipcMainHandle(
    'preview:load-remote-structure',
    (_event, request: RemoteStructureRequest): Promise<StructureRemoteLoadResult> =>
      loadRemoteStructure
        ? loadRemoteStructure(request)
        : Promise.resolve({
            ok: false,
            reason: 'not-configured',
            detail: '这个实例里没有配置远程结构加载器。'
          })
  )
}

export {
  createDefaultPreviewStateRepository,
  createDefaultProjectRepository,
  createProjectHandlers,
  registerProjectIpcHandlers
}
export type { ProjectHandlers }
