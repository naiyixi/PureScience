import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createProjectFilesHandlers,
  registerProjectFilesIpcHandlers,
  type ProjectFilesHandlers,
  type ProjectFilesQueryRepository,
  type ProjectFilesRecoveryBackend,
  type ProjectFilesRepairBackend
} from './ipc'

// Capture ipcMain.handle registrations so the registered handler can be invoked directly from tests.
const { handlers, registrationFailure } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, payload: unknown) => unknown>(),
  registrationFailure: {
    channel: undefined as string | undefined,
    error: undefined as Error | undefined
  }
}))

// The read instrument logs through this module's logger; capture the slow-read lines.
const { warnSpy } = vi.hoisted(() => ({ warnSpy: vi.fn() }))
vi.mock('../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: warnSpy, error: vi.fn() })
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, payload: unknown) => unknown) => {
      if (registrationFailure.channel === channel) throw registrationFailure.error
      handlers.set(channel, handler)
    }
  }
}))

// Both ports are stubbed from one place: a new repository method is then one edit here, instead of one per
// literal below (the count of literals is what made the earlier attempt insert a duplicate and miss a case).
const createRepository = (
  overrides: Partial<ProjectFilesQueryRepository> = {}
): ProjectFilesQueryRepository => ({
  getOverview: vi.fn(),
  listFiles: vi.fn(),
  listKinds: vi.fn(),
  listArtifactGroups: vi.fn(),
  searchArtifacts: vi.fn(),
  ...overrides
})

const createHandlers = (overrides: Partial<ProjectFilesHandlers> = {}): ProjectFilesHandlers => ({
  getOverview: vi.fn(),
  listFiles: vi.fn(),
  listKinds: vi.fn(),
  listArtifactGroups: vi.fn(),
  searchArtifacts: vi.fn(),
  repairIndex: vi.fn(),
  ...overrides
})

const invoke = (channel: string, payload: unknown): unknown =>
  handlers.get(channel)!(undefined, payload)

describe('project files read timing', () => {
  it('splits a slow read into the recovery gate and the query, and stays quiet when a read is fast', async () => {
    // The Files panel's cost is (gate + query); nothing said which half, and the Home page asks every
    // project for its files, so one slow half is multiplied by the project count.
    const listFiles = vi.fn(async () => ({ items: [], nextCursor: undefined, totalCount: 0 }))
    const recoverPendingDeletions = vi.fn(async () => undefined)
    const handlersWithTiming = createProjectFilesHandlers(
      createRepository({ listFiles } as never),
      { repairProjectFiles: vi.fn() } as never,
      { recoverPendingDeletions } as never
    )

    const clock = vi.spyOn(Date, 'now')
    warnSpy.mockClear()

    // fast: no line
    clock.mockReturnValueOnce(1_000).mockReturnValueOnce(1_010).mockReturnValueOnce(1_020)
    await handlersWithTiming.listFiles({ projectId: 'project-1' } as never)
    expect(warnSpy).not.toHaveBeenCalled()

    // slow: one line, with the split (gate 80 ms, query 120 ms, total 200 ms)
    clock.mockReturnValueOnce(2_000).mockReturnValueOnce(2_080).mockReturnValueOnce(2_200)
    await handlersWithTiming.listFiles({ projectId: 'project-1' } as never)
    expect(warnSpy).toHaveBeenCalledWith('project files read was slow', {
      operation: 'listFiles',
      totalMs: 200,
      recoveryMs: 80,
      queryMs: 120
    })

    clock.mockRestore()
  })
})

describe('project files IPC handlers', () => {
  it('routes overview, layered page and batched kind requests through one repository', async () => {
    const overview = {
      totalCount: 3,
      uploadCount: 1,
      artifactCount: 2,
      artifactGroupCount: 1,
      isIndexComplete: true
    }
    const filePage = { items: [], totalCount: 1 }
    const groupPage = { items: [], totalCount: 1 }
    const kindSummaries = [{ projectId: 'project-1', kinds: ['MD'] }]
    const artifactSearch = {
      primary: { items: [], totalCount: 0 },
      other: [],
      isIndexComplete: true
    }
    const repository = createRepository({
      getOverview: vi.fn().mockResolvedValue(overview),
      listFiles: vi.fn().mockResolvedValue(filePage),
      listKinds: vi.fn().mockResolvedValue(kindSummaries),
      listArtifactGroups: vi.fn().mockResolvedValue(groupPage),
      searchArtifacts: vi.fn().mockResolvedValue(artifactSearch)
    })
    const handlers = createProjectFilesHandlers(
      repository,
      {
        repairProjectFiles: vi.fn().mockResolvedValue(undefined)
      },
      {
        recoverPendingDeletions: vi.fn().mockResolvedValue(undefined)
      }
    )
    const filesRequest = {
      projectId: 'project-1',
      collection: { kind: 'uploads' as const },
      limit: 24
    }
    const kindsRequest = { projectIds: ['project-1', 'project-2'] }
    const groupsRequest = { projectId: 'project-1', limit: 10 }
    const artifactSearchRequest = {
      primaryProjectId: 'project-1',
      otherProjectIds: ['project-2'],
      filenameContains: 'sin',
      primaryLimit: 8,
      otherLimit: 1 as const
    }

    const overviewRequest = {
      projectId: 'project-1',
      search: { filenameContains: 'timeline' }
    }
    await expect(handlers.getOverview(overviewRequest)).resolves.toBe(overview)
    await expect(handlers.listFiles(filesRequest)).resolves.toBe(filePage)
    await expect(handlers.listKinds(kindsRequest)).resolves.toBe(kindSummaries)
    await expect(handlers.listArtifactGroups(groupsRequest)).resolves.toBe(groupPage)
    await expect(handlers.searchArtifacts(artifactSearchRequest)).resolves.toBe(artifactSearch)
    expect(repository.listFiles).toHaveBeenCalledWith(filesRequest)
    expect(repository.listKinds).toHaveBeenCalledWith(kindsRequest)
    expect(repository.listArtifactGroups).toHaveBeenCalledWith(groupsRequest)
    expect(repository.getOverview).toHaveBeenCalledWith(overviewRequest)
    expect(repository.searchArtifacts).toHaveBeenCalledWith(artifactSearchRequest)
  })

  it('routes an explicit index repair through the session coordinator', async () => {
    const repository = createRepository()
    const repair = { repairProjectFiles: vi.fn().mockResolvedValue(undefined) }
    const handlers = createProjectFilesHandlers(repository, repair, {
      recoverPendingDeletions: vi.fn().mockResolvedValue(undefined)
    })

    await handlers.repairIndex({ projectId: 'project-1' })

    expect(repair.repairProjectFiles).toHaveBeenCalledWith('project-1')
  })

  it('waits for deletion recovery before every files query or repair', async () => {
    const order: string[] = []
    const repository = createRepository({
      getOverview: vi.fn(async () => {
        order.push('overview')
        return {
          totalCount: 0,
          uploadCount: 0,
          artifactCount: 0,
          artifactGroupCount: 0,
          isIndexComplete: true
        }
      }),
      listFiles: vi.fn(async () => {
        order.push('files')
        return { items: [], totalCount: 0 }
      }),
      listKinds: vi.fn(async () => {
        order.push('kinds')
        return []
      }),
      listArtifactGroups: vi.fn(async () => {
        order.push('groups')
        return { items: [], totalCount: 0 }
      }),
      searchArtifacts: vi.fn(async () => {
        order.push('search')
        return { primary: { items: [], totalCount: 0 }, other: [], isIndexComplete: true }
      })
    })
    const repair = {
      repairProjectFiles: vi.fn(async () => {
        order.push('repair')
      })
    }
    const recovery = {
      recoverPendingDeletions: vi.fn(async () => {
        order.push('recover')
      })
    }
    const handlers = createProjectFilesHandlers(repository, repair, recovery)

    await handlers.getOverview({ projectId: 'project-1' })
    await handlers.listFiles({
      projectId: 'project-1',
      collection: { kind: 'uploads' },
      limit: 20
    })
    await handlers.listKinds({ projectIds: ['project-1'] })
    await handlers.listArtifactGroups({ projectId: 'project-1', limit: 10 })
    await handlers.searchArtifacts({
      primaryProjectId: 'project-1',
      otherProjectIds: [],
      primaryLimit: 8,
      otherLimit: 0
    })
    await handlers.repairIndex({ projectId: 'project-1' })

    expect(order).toEqual([
      'recover',
      'overview',
      'recover',
      'files',
      'recover',
      'kinds',
      'recover',
      'groups',
      'recover',
      'search',
      'recover',
      'repair'
    ])
  })
})

describe('registerProjectFilesIpcHandlers', () => {
  let repository: ProjectFilesQueryRepository
  let repairBackend: ProjectFilesRepairBackend
  let recoveryBackend: ProjectFilesRecoveryBackend

  beforeEach(() => {
    handlers.clear()
    registrationFailure.channel = undefined
    registrationFailure.error = undefined
    repository = createRepository({
      getOverview: vi.fn().mockResolvedValue({
        totalCount: 0,
        uploadCount: 0,
        artifactCount: 0,
        artifactGroupCount: 0,
        isIndexComplete: true
      }),
      listFiles: vi.fn().mockResolvedValue({ items: [], totalCount: 0 }),
      listKinds: vi.fn().mockResolvedValue([]),
      listArtifactGroups: vi.fn().mockResolvedValue({ items: [], totalCount: 0 }),
      searchArtifacts: vi.fn().mockResolvedValue({
        primary: { items: [], totalCount: 0 },
        other: [],
        isIndexComplete: true
      })
    })
    repairBackend = { repairProjectFiles: vi.fn().mockResolvedValue(undefined) }
    recoveryBackend = { recoverPendingDeletions: vi.fn().mockResolvedValue(undefined) }
  })

  it('registers every project-files IPC channel', () => {
    registerProjectFilesIpcHandlers(repository, repairBackend, recoveryBackend)

    expect(handlers.has('project-files:get-overview')).toBe(true)
    expect(handlers.has('project-files:list-files')).toBe(true)
    expect(handlers.has('project-files:list-kinds')).toBe(true)
    expect(handlers.has('project-files:list-artifact-groups')).toBe(true)
    expect(handlers.has('project-files:search-artifacts')).toBe(true)
    expect(handlers.has('project-files:repair-index')).toBe(true)
  })

  it('dispatches through the injected application handler identity', async () => {
    const overview = {
      totalCount: 0,
      uploadCount: 0,
      artifactCount: 0,
      artifactGroupCount: 0,
      isIndexComplete: true
    }
    const injected = createHandlers({ getOverview: vi.fn().mockResolvedValue(overview) })

    registerProjectFilesIpcHandlers(repository, repairBackend, recoveryBackend, injected)

    await expect(invoke('project-files:get-overview', { projectId: 'project-1' })).resolves.toBe(
      overview
    )
    expect(injected.getOverview).toHaveBeenCalledWith({ projectId: 'project-1' })
    expect(repository.getOverview).not.toHaveBeenCalled()
    expect(recoveryBackend.recoverPendingDeletions).not.toHaveBeenCalled()
  })

  it('preserves an injected handler identity when registration fails', async () => {
    const failure = new Error('registration failed')
    const injected = createHandlers({
      getOverview: vi.fn().mockResolvedValue({
        totalCount: 0,
        uploadCount: 0,
        artifactCount: 0,
        artifactGroupCount: 0,
        isIndexComplete: true
      })
    })
    registrationFailure.channel = 'project-files:get-overview'
    registrationFailure.error = failure

    expect(() =>
      registerProjectFilesIpcHandlers(repository, repairBackend, recoveryBackend, injected)
    ).toThrow(failure)

    registrationFailure.channel = undefined
    registrationFailure.error = undefined
    registerProjectFilesIpcHandlers(repository, repairBackend, recoveryBackend, injected)
    await invoke('project-files:get-overview', { projectId: 'project-1' })
    expect(injected.getOverview).toHaveBeenCalledOnce()
  })

  it('get-overview handler waits for deletion recovery before reading the overview', async () => {
    const order: string[] = []
    const localRepository = createRepository({
      getOverview: vi.fn(async () => {
        order.push('overview')
        return {
          totalCount: 0,
          uploadCount: 0,
          artifactCount: 0,
          artifactGroupCount: 0,
          isIndexComplete: true
        }
      })
    })
    const localRepair: ProjectFilesRepairBackend = {
      repairProjectFiles: vi.fn()
    }
    const localRecovery: ProjectFilesRecoveryBackend = {
      recoverPendingDeletions: vi.fn(async () => {
        order.push('recover')
      })
    }
    registerProjectFilesIpcHandlers(localRepository, localRepair, localRecovery)

    await invoke('project-files:get-overview', { projectId: 'project-1' })

    expect(order).toEqual(['recover', 'overview'])
    expect(localRepository.getOverview).toHaveBeenCalledWith({ projectId: 'project-1' })
  })

  it('list-files handler waits for deletion recovery before listing files', async () => {
    const order: string[] = []
    const localRepository = createRepository({
      listFiles: vi.fn(async () => {
        order.push('files')
        return { items: [], totalCount: 0 }
      })
    })
    const localRepair: ProjectFilesRepairBackend = {
      repairProjectFiles: vi.fn()
    }
    const localRecovery: ProjectFilesRecoveryBackend = {
      recoverPendingDeletions: vi.fn(async () => {
        order.push('recover')
      })
    }
    registerProjectFilesIpcHandlers(localRepository, localRepair, localRecovery)

    const filesRequest = {
      projectId: 'project-1',
      collection: { kind: 'uploads' },
      limit: 24
    }
    await invoke('project-files:list-files', filesRequest)

    expect(order).toEqual(['recover', 'files'])
    expect(localRepository.listFiles).toHaveBeenCalledWith(filesRequest)
  })

  it('list-kinds handler waits for deletion recovery before deriving kinds', async () => {
    const order: string[] = []
    const summaries = [{ projectId: 'project-1', kinds: ['MD', 'CSV'] }]
    const localRepository = createRepository({
      listKinds: vi.fn(async () => {
        order.push('kinds')
        return summaries
      })
    })
    const localRepair: ProjectFilesRepairBackend = {
      repairProjectFiles: vi.fn()
    }
    const localRecovery: ProjectFilesRecoveryBackend = {
      recoverPendingDeletions: vi.fn(async () => {
        order.push('recover')
      })
    }
    registerProjectFilesIpcHandlers(localRepository, localRepair, localRecovery)

    const kindsRequest = { projectIds: ['project-1'] }
    await expect(invoke('project-files:list-kinds', kindsRequest)).resolves.toBe(summaries)

    expect(order).toEqual(['recover', 'kinds'])
    expect(localRepository.listKinds).toHaveBeenCalledWith(kindsRequest)
  })

  it('list-artifact-groups handler waits for deletion recovery before listing groups', async () => {
    const order: string[] = []
    const localRepository = createRepository({
      listArtifactGroups: vi.fn(async () => {
        order.push('groups')
        return { items: [], totalCount: 0 }
      })
    })
    const localRepair: ProjectFilesRepairBackend = {
      repairProjectFiles: vi.fn()
    }
    const localRecovery: ProjectFilesRecoveryBackend = {
      recoverPendingDeletions: vi.fn(async () => {
        order.push('recover')
      })
    }
    registerProjectFilesIpcHandlers(localRepository, localRepair, localRecovery)

    const groupsRequest = { projectId: 'project-1', limit: 10 }
    await invoke('project-files:list-artifact-groups', groupsRequest)

    expect(order).toEqual(['recover', 'groups'])
    expect(localRepository.listArtifactGroups).toHaveBeenCalledWith(groupsRequest)
  })

  it('repair-index handler waits for deletion recovery before repairing the index', async () => {
    const order: string[] = []
    const localRepository = createRepository()
    const localRepair: ProjectFilesRepairBackend = {
      repairProjectFiles: vi.fn(async () => {
        order.push('repair')
      })
    }
    const localRecovery: ProjectFilesRecoveryBackend = {
      recoverPendingDeletions: vi.fn(async () => {
        order.push('recover')
      })
    }
    registerProjectFilesIpcHandlers(localRepository, localRepair, localRecovery)

    await invoke('project-files:repair-index', { projectId: 'project-1' })

    expect(order).toEqual(['recover', 'repair'])
    expect(localRepair.repairProjectFiles).toHaveBeenCalledWith('project-1')
  })

  it('registered handlers share the same wait-then-dispatch pattern', async () => {
    // Each handler in the registered table must go through the same gate; this protects against
    // accidentally bypassing recovery by registering a handler that calls the backend directly.
    registerProjectFilesIpcHandlers(repository, repairBackend, recoveryBackend)
    ;(recoveryBackend.recoverPendingDeletions as ReturnType<typeof vi.fn>).mockClear()

    await invoke('project-files:get-overview', { projectId: 'p1' })
    await invoke('project-files:list-files', {
      projectId: 'p1',
      collection: { kind: 'uploads' },
      limit: 1
    })
    await invoke('project-files:list-kinds', { projectIds: ['p1'] })
    await invoke('project-files:list-artifact-groups', { projectId: 'p1', limit: 1 })
    await invoke('project-files:repair-index', { projectId: 'p1' })

    expect(recoveryBackend.recoverPendingDeletions).toHaveBeenCalledTimes(5)
  })
})

export {}
