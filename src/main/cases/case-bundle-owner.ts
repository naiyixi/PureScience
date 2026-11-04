import type {
  CaseBundleExportOutcome,
  CaseBundleExportProblem,
  CaseBundleExportRequest,
  CaseBundleImportOutcome,
  CaseBundleImportProblem,
  CaseBundleImportRefusal,
  CaseBundleImportRequest,
  CaseBundleManifest
} from '../../shared/case-bundle'
import type { ManagedPreviewSource } from '../../shared/preview-resources'

// The command side of case bundles: the window names files the way the file list names them (`source` + `path`),
// never as absolute paths, and this module is where those names become paths the export may read.
//
// The trust boundary is the same one the OCR channel uses: a window can only export files it could already
// preview, because resolution goes through the same resolver. A file the resolver refuses is reported as
// `unreadable` — and the export does not start, so no bundle is written with holes in it.

export type CaseBundlePathResolver = (request: {
  source: ManagedPreviewSource
  path: string
  projectId?: string
  sessionId?: string
}) => Promise<string>

export type CaseBundleWriter = (input: {
  caseName: string
  domain: string
  summary?: string
  destinationDir: string
  files: ReadonlyArray<{ name: string; sourcePath: string; kind?: string }>
}) => Promise<
  | { ok: true; bundleDir: string; fileCount: number; totalBytes: number }
  | { ok: false; problem: CaseBundleExportProblem; detail?: string }
>

export type CaseBundleReader = (bundleDir: string) => Promise<
  | { ok: true; bundle: { manifest: CaseBundleManifest; totalBytes: number } }
  | {
      ok: false
      problem: CaseBundleImportProblem
      detail?: string
      problematic?: { missing: string[]; checksumMismatch: string[]; unexpected: string[] }
    }
>

// The main process owns what a project *has*: the window asks for a case by project id, and this asks the file
// catalogue for that project's files. The identities it returns are the same (`source` + `path`) a window would
// have handed over, so the resolver below stays the single decision point about readability.
export type CaseBundleFileEnumerator = (projectId: string) => Promise<
  | {
      ok: true
      files: ReadonlyArray<{
        name: string
        source: ManagedPreviewSource
        path: string
        kind?: string
      }>
    }
  | { ok: false; detail?: string }
>

export type CaseBundleCommandOwner = {
  export: (request: CaseBundleExportRequest) => Promise<CaseBundleExportOutcome>
  import: (request: CaseBundleImportRequest) => Promise<CaseBundleImportOutcome>
}

export const createCaseBundleCommandOwner = (options: {
  write: CaseBundleWriter
  read: CaseBundleReader
  resolvePath: CaseBundlePathResolver
  enumerate: CaseBundleFileEnumerator
  materialise: (
    bundleDir: string,
    targetDir: string
  ) => Promise<
    | { ok: true; directory: string; fileCount: number; totalBytes: number }
    | { ok: false; problem: CaseBundleImportRefusal; detail?: string }
  >
}): CaseBundleCommandOwner => ({
  export: async (request) => {
    let named = request.files
    if (!named) {
      const enumerated = await options.enumerate(request.projectId)
      if (!enumerated.ok) {
        return {
          status: 'refused',
          reason: 'unreadable',
          ...(enumerated.detail === undefined ? {} : { detail: enumerated.detail })
        }
      }
      named = enumerated.files.map((file) => ({
        name: file.name,
        source: file.source,
        path: file.path,
        ...(file.kind === undefined ? {} : { kind: file.kind })
      }))
    }
    if (named.length === 0) return { status: 'refused', reason: 'no-files' }

    const resolved: Array<{ name: string; sourcePath: string; kind?: string }> = []
    for (const file of named) {
      let sourcePath: string
      try {
        sourcePath = await options.resolvePath({
          source: file.source,
          path: file.path,
          // A file enumerated from the project belongs to that project; a named one says so itself.
          projectId: file.projectId ?? request.projectId,
          ...(file.sessionId === undefined ? {} : { sessionId: file.sessionId })
        })
      } catch (cause) {
        // The resolver's message is the reason the reader can act on ("outside the workspace", "not found"), so
        // it travels with the refusal instead of being flattened into a generic failure.
        return {
          status: 'refused',
          reason: 'unreadable',
          detail: cause instanceof Error ? cause.message : String(cause)
        }
      }
      if (typeof sourcePath !== 'string' || sourcePath === '') {
        return { status: 'refused', reason: 'unreadable', detail: file.name }
      }
      resolved.push({
        name: file.name,
        sourcePath,
        ...(file.kind === undefined ? {} : { kind: file.kind })
      })
    }

    const written = await options.write({
      caseName: request.caseName,
      domain: request.domain,
      ...(request.summary === undefined ? {} : { summary: request.summary }),
      destinationDir: request.destinationDir,
      files: resolved
    })
    if (!written.ok) {
      return {
        status: 'refused',
        reason: written.problem,
        ...(written.detail === undefined ? {} : { detail: written.detail })
      }
    }
    return {
      status: 'exported',
      bundleDir: written.bundleDir,
      fileCount: written.fileCount,
      totalBytes: written.totalBytes
    }
  },

  import: async (request) => {
    const read = await options.read(request.bundleDir)
    if (!read.ok) {
      return {
        status: 'refused',
        reason: read.problem,
        ...(read.detail === undefined ? {} : { detail: read.detail }),
        ...(read.problematic === undefined ? {} : { problematic: read.problematic })
      }
    }
    const { manifest } = read.bundle
    let materialisedTo: string | undefined
    if (request.materialiseTo !== undefined) {
      const written = await options.materialise(request.bundleDir, request.materialiseTo)
      if (!written.ok) {
        return {
          status: 'refused',
          reason: written.problem,
          ...(written.detail === undefined ? {} : { detail: written.detail })
        }
      }
      materialisedTo = written.directory
    }
    return {
      status: 'imported',
      name: manifest.name,
      domain: manifest.domain,
      fileCount: manifest.files.length,
      totalBytes: read.bundle.totalBytes,
      manifest,
      ...(materialisedTo === undefined ? {} : { materialisedTo })
    }
  }
})
