import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

import {
  CASE_BUNDLE_FILE_LIMIT,
  buildCaseBundle,
  type CaseBundleFile,
  type CaseBundleManifest
} from '../../shared/case-bundle'

// Writing a case bundle to disk: the half of "export" that touches the file system.
//
// Two rules drive the shape of this module:
//
// 1. **The bundle is written whole or not at all.** Every file is copied into a staging directory, its checksum
//    computed from the bytes that actually landed, and only then is the manifest written and the directory
//    renamed into place. A failure halfway through leaves the staging directory behind and no half-bundle that
//    a reader could mistake for a complete one.
// 2. **Names come from the manifest, not from the paths.** A file's name is sanitised to a single path segment
//    before it is joined onto the bundle directory — a manifest entry named `../../etc/passwd` is refused, not
//    resolved.
//
// The manifest is rebuilt through `buildCaseBundle` from the *measured* bytes, so the checksums in a written
// bundle are the ones this machine computed, never ones a caller supplied.

export const CASE_BUNDLE_MANIFEST_NAME = 'manifest.json'
export const CASE_BUNDLE_FILES_DIR = 'files'
export const CASE_BUNDLE_STAGING_PREFIX = '.case-bundle-staging-'

export type CaseBundleSourceFile = {
  // The name the bundle will carry. Sanitised: no separators, no `..`, not empty after trimming.
  name: string
  // An absolute path this machine has already resolved and is allowed to read.
  sourcePath: string
  kind?: string
}

export type CaseBundleExportInput = {
  caseName: string
  domain: string
  summary?: string
  destinationDir: string
  files: ReadonlyArray<CaseBundleSourceFile>
  createdAt?: number
}

export type CaseBundleExportProblem =
  | 'no-files'
  | 'too-many-files'
  | 'bad-file-name'
  | 'duplicate-file-name'
  | 'source-missing'
  | 'source-not-a-file'
  | 'destination-unusable'

export type CaseBundleExportResult =
  | {
      ok: true
      bundleDir: string
      manifest: CaseBundleManifest
      fileCount: number
      totalBytes: number
    }
  | { ok: false; problem: CaseBundleExportProblem; detail?: string }

// A single path segment: no separators, no parent traversal, and not the names the OS reserves.
const NAME_FORBIDDEN = /[\\/]/
const isUsableName = (name: string): boolean => {
  const trimmed = name.trim()
  if (trimmed === '' || trimmed === '.' || trimmed === '..') return false
  if (NAME_FORBIDDEN.test(trimmed)) return false
  // Control characters would make a directory listing unreadable and a shell dangerous.
  for (const character of trimmed) {
    if (character.codePointAt(0)! < 0x20) return false
  }
  return true
}

// The directory name for the case itself: keep letters/numbers/CJK, replace anything that would be awkward in
// a path or on a foreign file system.
export const caseBundleDirectoryName = (caseName: string): string => {
  const withoutControls = [...caseName.trim()]
    .filter((character) => character.codePointAt(0)! >= 0x20)
    .join('')
  const collapsed = withoutControls
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s-]+|[.\s-]+$/g, '')
  const bounded = collapsed.slice(0, 80).trim()
  return bounded === '' ? 'case' : bounded
}

const sha256OfFile = async (path: string): Promise<string> => {
  const bytes = await readFile(path)
  return createHash('sha256').update(bytes).digest('hex')
}

// Finds a directory name that is free, appending `-2`, `-3`, … rather than overwriting a previous export:
// re-exporting a case must never silently replace the bundle a reader already has.
export const uniqueBundleDir = async (destinationDir: string, name: string): Promise<string> => {
  for (let index = 1; index < 1000; index += 1) {
    const candidate = join(destinationDir, index === 1 ? name : `${name}-${index}`)
    const taken = await stat(candidate)
      .then(() => true)
      .catch(() => false)
    if (!taken) return candidate
  }
  return join(destinationDir, `${name}-${Date.now()}`)
}

export const exportCaseBundle = async (
  input: CaseBundleExportInput
): Promise<CaseBundleExportResult> => {
  const files = input.files
  if (files.length === 0) return { ok: false, problem: 'no-files' }
  if (files.length > CASE_BUNDLE_FILE_LIMIT) return { ok: false, problem: 'too-many-files' }

  const seen = new Set<string>()
  for (const file of files) {
    if (!isUsableName(file.name)) return { ok: false, problem: 'bad-file-name', detail: file.name }
    const key = file.name.trim().toLowerCase()
    if (seen.has(key)) return { ok: false, problem: 'duplicate-file-name', detail: file.name }
    seen.add(key)
  }

  // Everything is read before anything is written: a source that cannot be read must stop the export while the
  // destination is still untouched.
  const measured: Array<{ file: CaseBundleSourceFile; sizeBytes: number; sha256: string }> = []
  for (const file of files) {
    const info = await stat(file.sourcePath).catch(() => undefined)
    if (!info) return { ok: false, problem: 'source-missing', detail: file.name }
    if (!info.isFile()) return { ok: false, problem: 'source-not-a-file', detail: file.name }
    measured.push({
      file,
      sizeBytes: info.size,
      sha256: await sha256OfFile(file.sourcePath)
    })
  }

  const manifestFiles: CaseBundleFile[] = measured.map((entry) => ({
    name: entry.file.name.trim(),
    kind: entry.file.kind ?? basename(entry.file.name).split('.').pop() ?? 'file',
    sizeBytes: entry.sizeBytes,
    sha256: entry.sha256
  }))

  const built = buildCaseBundle({
    name: input.caseName,
    domain: input.domain,
    ...(input.summary ? { summary: input.summary } : {}),
    ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
    files: manifestFiles
  })
  if (!built.ok) {
    const mapped: CaseBundleExportProblem =
      built.problem === 'missing-name'
        ? 'bad-file-name'
        : built.problem === 'duplicate-file-name'
          ? 'duplicate-file-name'
          : built.problem === 'too-many-files'
            ? 'too-many-files'
            : 'no-files'
    return { ok: false, problem: mapped }
  }

  const bundleDir = await uniqueBundleDir(
    input.destinationDir,
    caseBundleDirectoryName(input.caseName)
  )
  const stagingDir = join(input.destinationDir, `${CASE_BUNDLE_STAGING_PREFIX}${Date.now()}`)
  try {
    await mkdir(join(stagingDir, CASE_BUNDLE_FILES_DIR), { recursive: true })
    for (const entry of measured) {
      await copyFile(
        entry.file.sourcePath,
        join(stagingDir, CASE_BUNDLE_FILES_DIR, entry.file.name.trim())
      )
    }
    await writeFile(
      join(stagingDir, CASE_BUNDLE_MANIFEST_NAME),
      `${JSON.stringify(built.manifest, null, 2)}\n`,
      'utf8'
    )
    await mkdir(input.destinationDir, { recursive: true })
    const { rename } = await import('node:fs/promises')
    await rename(stagingDir, bundleDir)
  } catch (cause) {
    return {
      ok: false,
      problem: 'destination-unusable',
      detail: cause instanceof Error ? cause.message : String(cause)
    }
  }

  return {
    ok: true,
    bundleDir,
    manifest: built.manifest,
    fileCount: measured.length,
    totalBytes: measured.reduce((sum, entry) => sum + entry.sizeBytes, 0)
  }
}
