// Reads, per project, the evidence a case card is allowed to quote: how many artifacts exist, of which
// kinds, and which files a reader would actually get. Everything here goes through IPC surfaces the app
// already ships (`projectFiles.getOverview` / `projectFiles.listFiles`) — a case is described by the same
// catalogue the Files view shows, so the card cannot claim a file the workspace would not hand over.
//
// Two reads, on purpose:
//   * `loadCaseOverview` is one cheap count query per project, so the section can rank *every* project
//     that ran before deciding which ones deserve a file listing — otherwise a machine with sixty
//     projects would only ever surface its eighteen most recent, and the richest case could be the one
//     that fell off the end;
//   * `loadCaseEvidence` pages the files for the shortlist only.
// Both are cached and de-duplicated: the home page re-mounts on every navigation.

import type { ProjectFileItem, ProjectFilesOverview } from '../../../../shared/project-files'
import type { CaseFile, CaseFootprint } from './user-cases'
import { collectKinds } from './user-cases'

export type ProjectCaseEvidence = {
  /** Absent when the catalogue read failed: the caller then says less, never zero. */
  overview?: ProjectFilesOverview
  files: ProjectFileItem[]
}

type CacheEntry<T> = { at: number; value: T }

const CACHE_TTL_MS = 60_000
const overviewCache = new Map<string, CacheEntry<ProjectFilesOverview | undefined>>()
const overviewInFlight = new Map<string, Promise<ProjectFilesOverview | undefined>>()
const evidenceCache = new Map<string, CacheEntry<ProjectCaseEvidence | undefined>>()
const evidenceInFlight = new Map<string, Promise<ProjectCaseEvidence | undefined>>()

/** How many files one case hands to the detail panel. The count comes from the overview, not this cap. */
export const CASE_FILE_SAMPLE_LIMIT = 60

export const clearCaseEvidenceCache = (): void => {
  overviewCache.clear()
  overviewInFlight.clear()
  evidenceCache.clear()
  evidenceInFlight.clear()
}

const readOverview = async (projectId: string): Promise<ProjectFilesOverview | undefined> => {
  const api = window.api?.projectFiles
  if (!api?.getOverview) return undefined
  try {
    return await api.getOverview({ projectId })
  } catch {
    return undefined
  }
}

export const loadCaseOverview = async (
  projectId: string,
  now = Date.now()
): Promise<ProjectFilesOverview | undefined> => {
  const hit = overviewCache.get(projectId)
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.value
  const pending = overviewInFlight.get(projectId)
  if (pending) return pending
  const request = readOverview(projectId)
    .then((value) => {
      overviewCache.set(projectId, { at: now, value })
      return value
    })
    .finally(() => {
      overviewInFlight.delete(projectId)
    })
  overviewInFlight.set(projectId, request)
  return request
}

/**
 * Counts for many projects in one round-trip. The section ranks *every* project that ran before choosing a
 * shortlist, so per-project reads made that many count queries queue ahead of the reads the reader is
 * waiting for; main answers the whole batch with two grouped queries instead.
 */
export const loadCaseOverviews = async (
  projectIds: string[],
  now = Date.now()
): Promise<Record<string, ProjectFilesOverview | undefined>> => {
  const api = window.api?.projectFiles
  const wanted = [...new Set(projectIds)]
  if (!api?.getOverviews || wanted.length === 0) return {}
  const fresh: string[] = []
  const result: Record<string, ProjectFilesOverview | undefined> = {}
  for (const projectId of wanted) {
    const hit = overviewCache.get(projectId)
    if (hit && now - hit.at < CACHE_TTL_MS) result[projectId] = hit.value
    else fresh.push(projectId)
  }
  if (fresh.length === 0) return result
  try {
    const entries = await api.getOverviews({ projectIds: fresh })
    for (const entry of entries) {
      const { projectId, ...overview } = entry
      overviewCache.set(projectId, { at: now, value: overview })
      result[projectId] = overview
    }
  } catch {
    // A failed batch read says less, never zero: the cards fall back to per-project reads below.
    for (const projectId of fresh) result[projectId] = await loadCaseOverview(projectId, now)
  }
  return result
}

const readEvidence = async (projectId: string): Promise<ProjectCaseEvidence | undefined> => {
  const api = window.api?.projectFiles
  if (!api?.listFiles) return undefined
  const [overview, page] = await Promise.all([
    loadCaseOverview(projectId),
    Promise.resolve(
      api.listFiles({
        projectId,
        collection: { kind: 'all' },
        limit: CASE_FILE_SAMPLE_LIMIT
      })
    ).catch(() => undefined)
  ])
  if (!overview && !page) return undefined
  return { overview, files: page?.items ?? [] }
}

export const loadCaseEvidence = async (
  projectId: string,
  now = Date.now()
): Promise<ProjectCaseEvidence | undefined> => {
  const hit = evidenceCache.get(projectId)
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.value
  const pending = evidenceInFlight.get(projectId)
  if (pending) return pending
  const request = readEvidence(projectId)
    .then((value) => {
      evidenceCache.set(projectId, { at: now, value })
      return value
    })
    .finally(() => {
      evidenceInFlight.delete(projectId)
    })
  evidenceInFlight.set(projectId, request)
  return request
}

/** The footprint a card quotes. Counts come from the overview; kinds come from the sampled names. */
export const footprintFromEvidence = (
  evidence: ProjectCaseEvidence | undefined,
  sessions: number
): CaseFootprint => {
  const files = evidence?.files ?? []
  const overview = evidence?.overview
  const artifactCount = overview?.artifactCount ?? 0
  const uploadCount = overview?.uploadCount ?? 0
  const kinds = collectKinds(files.map((file) => file.name))
  return {
    sessions,
    artifactCount,
    uploadCount,
    fileCount: overview?.totalCount ?? files.length,
    totalBytes: files.reduce((sum, file) => sum + (Number.isFinite(file.size) ? file.size : 0), 0),
    kinds
  }
}

/** Case files, biggest first: the report and the data are what a reader opens first. */
export const caseFilesFromEvidence = (evidence: ProjectCaseEvidence | undefined): CaseFile[] => {
  const files = evidence?.files ?? []
  return [...files]
    .sort((left, right) => (right.size ?? 0) - (left.size ?? 0))
    .slice(0, 12)
    .map((file) => {
      const dot = file.name.lastIndexOf('.')
      return {
        name: file.name,
        size: file.size ?? 0,
        kind: dot > 0 ? file.name.slice(dot + 1).toLowerCase() : ''
      }
    })
}

/** All file names the case knows about, for domain classification and search. */
export const caseFileNames = (evidence: ProjectCaseEvidence | undefined): string[] =>
  (evidence?.files ?? []).map((file) => file.name)
