import { Prisma, type ManagedFile } from '@prisma/client'

import { startDbCanary } from '../diagnostics/db-queue-probe'
import { readEventLoopLatency, resetEventLoopLatency } from '../diagnostics/event-loop-latency'
import { createLogger } from '../logger'

import type {
  ArtifactGroupPage,
  ListProjectFileKindsRequest,
  ProjectFileKindsSummary,
  GetProjectFilesOverviewRequest,
  ListArtifactGroupsRequest,
  ListProjectFilesRequest,
  ProjectFileItem,
  ProjectFilesOverview,
  ProjectFilesPage,
  SearchArtifactsRequest,
  SearchArtifactsResult
} from '../../shared/project-files'
import { deriveProjectFileKinds } from '../../shared/project-file-kinds'
import type { ProjectFilesClientProvider } from './mutation-projection'
import {
  countMatchingArtifacts,
  decodeFileCursor,
  decodeGroupCursor,
  decodeSearchArtifactCursor,
  encodeCursor,
  getMatchingOverviewCounts,
  listMatchingArtifactGroups,
  listMatchingArtifacts,
  listMatchingFiles,
  listOtherProjectArtifacts,
  normalizeLimit,
  normalizeSearch,
  requireIdentifier,
  toOriginProjection,
  toProjectFileItem,
  toSafeCount
} from './query-support'

type ProjectFilesIndexCompletenessReader = (projectId: string) => boolean

// "listFiles takes 211 ms" survived four explanations (missing index, per-call client, the recovery gate,
// raw SQL) and none of them held: the index exists and the plan is a SEARCH, the client is cached, the gate
// is 0 ms, and sqlite3 runs the same query in 0-20 ms on the real 463-row table. So the cost is inside this
// method, and this reports which segment it is — measured only when a read is slow.
const SLOW_LIST_SEGMENT_THRESHOLD_MS = 50
// Bounds for the batched kinds read: enough for any Home screen, and a per-project row cap small enough that
// the chips still come from a project's newest files rather than from an arbitrary slice.
const MAX_PROJECT_FILE_KINDS_PROJECTS = 100
const MAX_PROJECT_FILE_KINDS_ROWS_PER_PROJECT = 30
const queryLog = createLogger('project-files-query')

// U11 showed that a slow read here can be waiting on the shared Prisma engine rather than on its own query:
// a trivial `SELECT 1` started at the same moment was just as slow. That canary is the only way to tell
// "this read queued" from "this read was expensive", so both reads this file owns can carry it — but it is a
// second trip into the very queue being measured, so it is opt-in for measurement runs
// (PURESCIENCE_DB_CANARY=1) and off by default. While it is on, every read reports rather than only the slow
// tail, so a run has a distribution to compare instead of one threshold crossing.
const dbCanaryEnabled = (): boolean => process.env.PURESCIENCE_DB_CANARY === '1'

const withDbCanary = (
  client: { $queryRawUnsafe: <Result>(query: string, ...values: unknown[]) => Promise<Result> },
  enabled: boolean
): Promise<number> | undefined =>
  enabled ? startDbCanary(() => client.$queryRawUnsafe('SELECT 1')) : undefined

// Owns the read-model orchestration while completeness remains authoritative in the mutation owner.
class ProjectFilesQueryOwner {
  constructor(
    private readonly getClient: ProjectFilesClientProvider,
    private readonly dataRoot: string,
    private readonly readIndexComplete: ProjectFilesIndexCompletenessReader
  ) {}

  async getOverview(
    request: string | GetProjectFilesOverviewRequest
  ): Promise<ProjectFilesOverview> {
    const { projectId, search: rawSearch } =
      typeof request === 'string' ? { projectId: request, search: undefined } : request
    requireIdentifier(projectId, 'projectId')
    const search = normalizeSearch(rawSearch)
    const client = await this.getClient()
    const [totalCount, uploadCount, artifactCount, artifactGroupCount] = search
      ? await getMatchingOverviewCounts(client, projectId, search)
      : await Promise.all([
          client.managedFile.count({ where: { projectId, deletedAt: null } }),
          client.managedFile.count({ where: { projectId, source: 'upload', deletedAt: null } }),
          client.managedFile.count({ where: { projectId, source: 'artifact', deletedAt: null } }),
          client.managedFileSessionSync.count({
            where: { projectId, deletedAt: null, artifactCount: { gt: 0 } }
          })
        ])

    return {
      totalCount,
      uploadCount,
      artifactCount,
      artifactGroupCount,
      isIndexComplete: this.readIndexComplete(projectId)
    }
  }

  // One round-trip answers for many projects. The chips on the Home page need a project's newest file kinds,
  // and asking per project put one read per visible project into the same engine queue the list reads wait in.
  // A window function keeps the per-project semantics exact (newest 30 per project) inside a single query
  // instead of truncating globally by row count, which would starve whichever project sorts last.
  async listProjectFileKinds(
    request: ListProjectFileKindsRequest
  ): Promise<ProjectFileKindsSummary[]> {
    if (!Array.isArray(request?.projectIds)) return []
    const projectIds = [
      ...new Set(request.projectIds.filter((id): id is string => typeof id === 'string'))
    ]
    for (const projectId of projectIds) requireIdentifier(projectId, 'projectId')
    if (projectIds.length === 0) return []
    if (projectIds.length > MAX_PROJECT_FILE_KINDS_PROJECTS) {
      throw new Error(
        `Project file kinds accepts at most ${MAX_PROJECT_FILE_KINDS_PROJECTS} projects per read.`
      )
    }
    const client = await this.getClient()
    const startedAt = Date.now()
    const dbCanary = withDbCanary(client, dbCanaryEnabled())
    const placeholders = projectIds.map(() => '?').join(', ')
    const rows = await client.$queryRawUnsafe<
      Array<{ projectId: string; displayName: string; sortAtMs: bigint | number | string }>
    >(
      `SELECT projectId, displayName, sortAtMs FROM (
         SELECT projectId, displayName, sortAtMs,
                ROW_NUMBER() OVER (PARTITION BY projectId ORDER BY sortAtMs DESC, seq DESC) AS rowNumber
         FROM "ManagedFile"
         WHERE projectId IN (${placeholders}) AND deletedAt IS NULL
       ) WHERE rowNumber <= ?
       ORDER BY projectId ASC`,
      ...projectIds,
      MAX_PROJECT_FILE_KINDS_ROWS_PER_PROJECT
    )
    const itemsByProject = new Map<string, Array<{ name: string; sortAtMs: number }>>()
    for (const row of rows) {
      const bucket = itemsByProject.get(row.projectId) ?? []
      bucket.push({ name: row.displayName, sortAtMs: Number(row.sortAtMs) })
      itemsByProject.set(row.projectId, bucket)
    }
    const summaries = projectIds.map((projectId) => ({
      projectId,
      kinds: deriveProjectFileKinds(itemsByProject.get(projectId) ?? [])
    }))
    const totalMs = Date.now() - startedAt
    const reportThreshold = dbCanary ? 0 : SLOW_LIST_SEGMENT_THRESHOLD_MS
    if (totalMs >= reportThreshold) {
      try {
        queryLog.warn('project file kinds read was slow', {
          projects: projectIds.length,
          rows: rows.length,
          totalMs,
          dbCanaryMs: dbCanary ? await dbCanary : undefined
        })
      } catch {
        // Best-effort: a diagnostic must never replace the read result.
      }
    }
    return summaries
  }

  async listFiles(request: ListProjectFilesRequest): Promise<ProjectFilesPage> {
    requireIdentifier(request.projectId, 'projectId')
    const collection = request.collection as { kind?: unknown; sessionId?: unknown }
    let normalizedCollection: ListProjectFilesRequest['collection']
    if (collection.kind === 'all') {
      normalizedCollection = { kind: 'all' }
    } else if (collection.kind === 'uploads') {
      normalizedCollection = { kind: 'uploads' }
    } else if (collection.kind === 'sessionArtifacts' && typeof collection.sessionId === 'string') {
      requireIdentifier(collection.sessionId, 'sessionId')
      normalizedCollection = { kind: 'sessionArtifacts', sessionId: collection.sessionId }
    } else {
      throw new Error('Project files collection is invalid.')
    }
    const normalizedRequest = { ...request, collection: normalizedCollection }
    const startedAt = Date.now()
    resetEventLoopLatency()
    const client = await this.getClient()
    const clientMs = Date.now() - startedAt
    const dbCanary = withDbCanary(client, dbCanaryEnabled())
    const limit = normalizeLimit(request.limit)
    const search = normalizeSearch(request.search)
    const source =
      normalizedCollection.kind === 'all'
        ? undefined
        : normalizedCollection.kind === 'uploads'
          ? 'upload'
          : 'artifact'
    const sessionId =
      normalizedCollection.kind === 'sessionArtifacts' ? normalizedCollection.sessionId : undefined
    if (sessionId && search?.excludedSessionIds.includes(sessionId)) {
      return { items: [], totalCount: 0 }
    }
    const cursor = request.cursor ? decodeFileCursor(request.cursor, normalizedRequest) : undefined
    const where: Prisma.ManagedFileWhereInput = {
      projectId: request.projectId,
      ...(source ? { source } : {}),
      deletedAt: null,
      ...(sessionId !== undefined
        ? { sessionId }
        : search?.excludedSessionIds.length
          ? { sessionId: { notIn: search.excludedSessionIds } }
          : {}),
      ...(cursor
        ? {
            OR: [
              { sortAtMs: { lt: BigInt(cursor.sortAtMs) } },
              { sortAtMs: BigInt(cursor.sortAtMs), seq: { lt: cursor.seq } }
            ]
          }
        : {})
    }
    const [rows, totalCount] = search
      ? await listMatchingFiles(client, request.projectId, source, sessionId, search, cursor, limit)
      : await Promise.all([
          client.managedFile.findMany({
            where,
            orderBy: [{ sortAtMs: 'desc' }, { seq: 'desc' }],
            take: limit + 1
          }),
          client.managedFile.count({
            where: {
              projectId: request.projectId,
              ...(source ? { source } : {}),
              deletedAt: null,
              ...(sessionId !== undefined ? { sessionId } : {})
            }
          })
        ])
    const rowsMs = Date.now() - startedAt
    const pageRows = rows.slice(0, limit)
    const lastRow = pageRows.at(-1)
    // Origin data is a second engine round-trip; callers that only derive file kinds skip it (see the request
    // type). Read paths that render Session attribution keep it.
    const origins = request.omitOrigins
      ? []
      : await client.fileOriginSession.findMany({
          where: {
            projectId: request.projectId,
            sessionId: { in: [...new Set(pageRows.map((row) => row.sessionId))] }
          }
        })
    const originsBySession = new Map(origins.map((origin) => [origin.sessionId, origin]))
    const originsMs = Date.now() - startedAt

    const items = pageRows.map((row) =>
      toProjectFileItem(row, this.dataRoot, originsBySession.get(row.sessionId))
    )
    const totalMs = Date.now() - startedAt
    const reportThreshold = dbCanary ? 0 : SLOW_LIST_SEGMENT_THRESHOLD_MS
    if (totalMs >= reportThreshold) {
      try {
        queryLog.warn('listFiles segments were slow', {
          rows: pageRows.length,
          ...readEventLoopLatency(),
          totalMs,
          clientMs,
          rowsMs: rowsMs - clientMs,
          originsMs: originsMs - rowsMs,
          mapMs: totalMs - originsMs,
          dbCanaryMs: dbCanary ? await dbCanary : undefined
        })
      } catch {
        // Best-effort: a diagnostic must never replace the read result.
      }
    }

    return {
      items,
      totalCount,
      nextCursor:
        rows.length > limit && lastRow
          ? encodeCursor({
              version: 2,
              kind: normalizedCollection.kind,
              projectId: request.projectId,
              sessionId,
              queryKey: search?.queryKey ?? '',
              sortAtMs: lastRow.sortAtMs.toString(),
              seq: lastRow.seq
            })
          : undefined
    }
  }

  async searchArtifacts(request: SearchArtifactsRequest): Promise<SearchArtifactsResult> {
    requireIdentifier(request.primaryProjectId, 'primaryProjectId')
    if (!Array.isArray(request.otherProjectIds)) {
      throw new Error('Project files otherProjectIds must be an array.')
    }
    const otherProjectIds = [...new Set(request.otherProjectIds)]
      .filter((projectId) => projectId !== request.primaryProjectId)
      .map((projectId) => {
        requireIdentifier(projectId, 'otherProjectId')
        return projectId
      })
    if (!Number.isInteger(request.otherLimit) || request.otherLimit < 0 || request.otherLimit > 5) {
      throw new Error('Project files otherLimit must be between 0 and 5.')
    }

    const primaryLimit = normalizeLimit(request.primaryLimit)
    const search = normalizeSearch({
      filenameContains: request.filenameContains ?? '',
      ...(request.excludedSessionIds === undefined
        ? {}
        : { excludedSessionIds: request.excludedSessionIds })
    })
    const cursor = request.primaryCursor
      ? decodeSearchArtifactCursor(request.primaryCursor, request.primaryProjectId, search)
      : undefined
    const client = await this.getClient()
    const excludedSessionIds = search?.excludedSessionIds ?? []
    const [primaryRows, primaryTotalCount, otherRows] = await Promise.all([
      listMatchingArtifacts(
        client,
        request.primaryProjectId,
        search,
        excludedSessionIds,
        cursor,
        primaryLimit
      ),
      countMatchingArtifacts(client, request.primaryProjectId, search, excludedSessionIds),
      request.otherLimit > 0 && otherProjectIds.length > 0
        ? listOtherProjectArtifacts(
            client,
            otherProjectIds,
            search,
            excludedSessionIds,
            request.otherLimit
          )
        : Promise.resolve([])
    ])
    const primaryPageRows = primaryRows.slice(0, primaryLimit)
    const lastPrimaryRow = primaryPageRows.at(-1)
    const rows = [...primaryPageRows, ...otherRows]
    const origins =
      rows.length === 0
        ? []
        : await client.fileOriginSession.findMany({
            where: {
              OR: [
                ...new Map(rows.map((row) => [`${row.projectId}:${row.sessionId}`, row])).values()
              ].map((row) => ({ projectId: row.projectId, sessionId: row.sessionId }))
            }
          })
    const originsBySession = new Map(
      origins.map((origin) => [`${origin.projectId}:${origin.sessionId}`, origin])
    )
    const toItem = (row: ManagedFile): ProjectFileItem =>
      toProjectFileItem(
        row,
        this.dataRoot,
        originsBySession.get(`${row.projectId}:${row.sessionId}`)
      )

    return {
      primary: {
        items: primaryPageRows.map(toItem),
        totalCount: primaryTotalCount,
        nextCursor:
          primaryRows.length > primaryLimit && lastPrimaryRow
            ? encodeCursor({
                version: 2,
                kind: 'globalArtifacts',
                primaryProjectId: request.primaryProjectId,
                queryKey: search?.queryKey ?? '',
                sortAtMs: lastPrimaryRow.sortAtMs.toString(),
                seq: lastPrimaryRow.seq
              })
            : undefined
      },
      other: otherRows.map(toItem),
      isIndexComplete: [request.primaryProjectId, ...otherProjectIds].every((projectId) =>
        this.readIndexComplete(projectId)
      )
    }
  }

  async listArtifactGroups(request: ListArtifactGroupsRequest): Promise<ArtifactGroupPage> {
    requireIdentifier(request.projectId, 'projectId')
    const client = await this.getClient()
    const limit = normalizeLimit(request.limit)
    const search = normalizeSearch(request.search)
    const cursor = request.cursor ? decodeGroupCursor(request.cursor, request) : undefined
    const groupWhere: Prisma.ManagedFileSessionSyncWhereInput = {
      projectId: request.projectId,
      deletedAt: null,
      artifactCount: { gt: 0 },
      ...(search?.excludedSessionIds.length
        ? { sessionId: { notIn: search.excludedSessionIds } }
        : {})
    }
    const where: Prisma.ManagedFileSessionSyncWhereInput = {
      ...groupWhere,
      ...(cursor
        ? {
            OR: [
              { groupSortAtMs: { lt: BigInt(cursor.groupSortAtMs) } },
              {
                groupSortAtMs: BigInt(cursor.groupSortAtMs),
                sessionId: { lt: cursor.sessionId }
              }
            ]
          }
        : {})
    }
    const [rows, totalCount] = search
      ? await listMatchingArtifactGroups(client, request.projectId, search, cursor, limit)
      : await Promise.all([
          client.managedFileSessionSync.findMany({
            where,
            orderBy: [{ groupSortAtMs: 'desc' }, { sessionId: 'desc' }],
            take: limit + 1
          }),
          client.managedFileSessionSync.count({
            where: groupWhere
          })
        ])
    const pageRows = rows.slice(0, limit)
    const lastRow = pageRows.at(-1)
    const origins = await client.fileOriginSession.findMany({
      where: {
        projectId: request.projectId,
        sessionId: { in: pageRows.map((row) => row.sessionId) }
      }
    })
    const originsBySession = new Map(origins.map((origin) => [origin.sessionId, origin]))

    return {
      items: pageRows.map((row) => ({
        sessionId: row.sessionId,
        artifactCount: toSafeCount(row.artifactCount, 'artifact group count'),
        ...toOriginProjection(originsBySession.get(row.sessionId))
      })),
      totalCount,
      nextCursor:
        rows.length > limit && lastRow
          ? encodeCursor({
              version: 2,
              kind: 'artifactGroups',
              projectId: request.projectId,
              queryKey: search?.queryKey ?? '',
              groupSortAtMs: lastRow.groupSortAtMs.toString(),
              sessionId: lastRow.sessionId
            })
          : undefined
    }
  }
}

export { ProjectFilesQueryOwner }
export type { ProjectFilesIndexCompletenessReader }
