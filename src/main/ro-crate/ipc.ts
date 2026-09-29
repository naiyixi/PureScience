// The desktop side of the RO-Crate export: the channel a window calls, and the one place the native save
// dialogue lives.
//
// Below this file everything is already tested: `writeRoCrateExport` reads the Project's published
// Artifact Versions off the durable provenance layout, copies their bytes, writes
// `ro-crate-metadata.json` and refuses its own output if the document does not pass every assertion. So
// this module does four things and nothing else: validate the request, resolve the Project's
// human-facing name, obtain a destination from the OS (the dialogue belongs to the window that invoked
// the channel, which only this adapter knows), and translate the writer's outcome into a NAMED result.
//
// The refusal vocabulary is the point. "It did not work" is useless to someone deciding what to do next,
// so a Project with nothing published, a Project whose Versions were all refused, an unwritable folder
// and a crate that failed validation are four different answers.

import { join } from 'node:path'
import type { SaveDialogOptions, SaveDialogReturnValue, WebContents } from 'electron'

import {
  RO_CRATE_EXPORT_CHANNEL,
  type RoCrateExportFailure,
  type RoCrateExportRefusedVersion,
  type RoCrateExportRequest,
  type RoCrateExportResult
} from '../../shared/ro-crate-export'
import { ipcMainHandle } from '../ipc-handler-registry'
import { createLogger, errorLogFields } from '../logger'
import { showSettingsSaveDialog } from '../settings/save-dialog'
import {
  RoCrateExportError,
  readRoCrateProjectVersions,
  writeRoCrateExport,
  type RoCrateSkippedVersion
} from './export'

/** The Project facts the crate needs. A missing Project is `null`, never an invented name. */
export type RoCrateProjectIdentity = Readonly<{ id: string; name: string; description: string }>

export type RoCrateExportOwnerDeps = Readonly<{
  /** Absolute data root. The crate is built from `<dataRoot>/artifacts/<projectId>/...`. */
  storageRoot: string
  loadProject: (projectId: string) => Promise<RoCrateProjectIdentity | null>
  app: Readonly<{ name: string; version: string; url: string }>
  /**
   * Directory the save dialogue opens in. Resolved lazily and defensively: `app.getPath` throws for a
   * folder the platform cannot resolve (a fresh Windows profile has no Downloads), and that must not be
   * what stops an export.
   */
  getDefaultDir: () => string | undefined
  showSaveDialog?: (
    sender: WebContents,
    options: SaveDialogOptions
  ) => Promise<SaveDialogReturnValue>
  exportCrate?: typeof writeRoCrateExport
  now?: () => Date
  log?: Readonly<{ warn: (message: string, fields?: unknown) => void }>
}>

export type RoCrateExportOwner = Readonly<{
  exportProject: (
    request: RoCrateExportRequest,
    sender: WebContents
  ) => Promise<RoCrateExportResult>
}>

// A crate is a directory, so its name is a DIRECTORY name: everything a path may not hold is folded away
// rather than deciding whether the export works. The suffix keeps an exported crate distinguishable from
// the project folder beside it.
const crateDirectoryName = (projectName: string): string => {
  const stem = projectName
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
  return `${stem || 'project'}-ro-crate`
}

const assertExportRequest = (request: RoCrateExportRequest): RoCrateExportRequest => {
  if (
    typeof request !== 'object' ||
    request === null ||
    typeof request.projectId !== 'string' ||
    request.projectId.length === 0 ||
    (request.destinationPath !== undefined && typeof request.destinationPath !== 'string') ||
    request.destinationPath === ''
  ) {
    throw new Error('Invalid RO-Crate export request.')
  }
  return request
}

const nodeErrorCode = (error: unknown): string | undefined =>
  typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined

// A folder the export may not create or write into is its own answer: the user picked it and can pick
// another one, which is not true of a crate that failed validation or a Project that published nothing.
// EEXIST is included because the crate's directories are created with `recursive: true`, so the only way
// that code can surface is a FILE already sitting where a crate folder has to go.
const UNWRITABLE_CODES = new Set([
  'EACCES',
  'EPERM',
  'EROFS',
  'ENOTDIR',
  'EISDIR',
  'EEXIST',
  'ENOSPC'
])

const toRefused = (skipped: readonly RoCrateSkippedVersion[]): RoCrateExportRefusedVersion[] =>
  skipped.map(({ appSessionId, artifactId, versionId, reason }) => ({
    appSessionId,
    artifactId,
    versionId,
    reason
  }))

export const createRoCrateExportOwner = (deps: RoCrateExportOwnerDeps): RoCrateExportOwner => {
  const showSaveDialog = deps.showSaveDialog ?? showSettingsSaveDialog
  const exportCrate = deps.exportCrate ?? writeRoCrateExport
  const log = deps.log ?? createLogger('ro-crate')
  const now = deps.now ?? ((): Date => new Date())

  /**
   * A failure the writer reported without a code carries no detail beyond its message, so the reason is
   * re-derived from the same durable layout the writer read: a Project with no published Version and a
   * Project whose Versions were all refused are different answers, and the difference is only visible in
   * that layout. This runs on the refusal path alone — the successful path reads the storage once.
   */
  const classifyWriterFailure = async (
    projectId: string,
    error: unknown
  ): Promise<RoCrateExportResult> => {
    if (error instanceof RoCrateExportError) {
      const { versions, skipped } = await readRoCrateProjectVersions({
        storageRoot: deps.storageRoot,
        projectId
      })
      if (versions.length === 0) {
        const refused = toRefused(skipped)
        return {
          ok: false,
          error: skipped.length > 0 ? 'no-exportable-version' : 'no-published-version',
          ...(refused.length > 0 ? { refused } : {})
        }
      }
      return { ok: false, error: 'validation-failed', detail: error.message }
    }
    const code = nodeErrorCode(error)
    const failure: RoCrateExportFailure =
      code !== undefined && UNWRITABLE_CODES.has(code) ? 'destination-unwritable' : 'write-failed'
    return {
      ok: false,
      error: failure,
      detail: error instanceof Error ? error.message : String(error)
    }
  }

  return Object.freeze({
    exportProject: async (
      rawRequest: RoCrateExportRequest,
      sender: WebContents
    ): Promise<RoCrateExportResult> => {
      const request = assertExportRequest(rawRequest)

      const project = await deps.loadProject(request.projectId)
      if (!project) return { ok: false, error: 'project-not-found' }

      let destination = request.destinationPath
      if (!destination) {
        let defaultDir: string | undefined
        try {
          defaultDir = deps.getDefaultDir() || undefined
        } catch {
          defaultDir = undefined
        }
        const suggested = crateDirectoryName(project.name)
        const selected = await showSaveDialog(sender, {
          title: 'Export project as RO-Crate',
          // No filters: the destination is a folder, and an extension filter would invite the platform
          // to append one to a directory name.
          ...(defaultDir
            ? { defaultPath: join(defaultDir, suggested) }
            : { defaultPath: suggested })
        })
        if (selected.canceled || !selected.filePath) return { ok: false, error: 'cancelled' }
        destination = selected.filePath
      }

      try {
        const result = await exportCrate({
          storageRoot: deps.storageRoot,
          outputDir: destination,
          projectId: project.id,
          projectName: project.name,
          // An empty description would fail the crate's own "name and description" check, so the writer's
          // default (which names the Project) is kept unless the Project really describes itself.
          ...(project.description.trim().length > 0
            ? { description: project.description.trim() }
            : {}),
          app: { ...deps.app },
          generatedAt: now().toISOString()
        })

        const refused = toRefused(result.skipped)
        return {
          ok: true,
          outputDir: result.outputDir,
          metadataPath: result.metadataPath,
          fileCount: result.files.length,
          totalBytes: result.files.reduce((total, file) => total + file.sizeBytes, 0),
          validation: { passed: result.validation.passed, failed: result.validation.failed },
          refusedCount: refused.length,
          refused
        }
      } catch (error) {
        // The rejection diagnostic already logs the channel; this keeps the reason next to the Project it
        // concerns, which is what a support bundle needs to explain a failed export.
        log.warn('RO-Crate export failed', {
          ...errorLogFields(error),
          projectId: project.id
        })
        return classifyWriterFailure(project.id, error)
      }
    }
  })
}

export const registerRoCrateExportIpcHandlers = (owner: RoCrateExportOwner): void => {
  ipcMainHandle(RO_CRATE_EXPORT_CHANNEL, (event, request: RoCrateExportRequest) =>
    owner.exportProject(request, event.sender)
  )
}
