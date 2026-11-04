import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

import {
  caseBundleIsComplete,
  reconcileCaseBundle,
  validateCaseBundle,
  type CaseBundleFile,
  type CaseBundleManifest
} from '../../shared/case-bundle'
import { CASE_BUNDLE_FILES_DIR, CASE_BUNDLE_MANIFEST_NAME } from './export-bundle'

// Reading a case bundle back: the mirror of export. Where export promises "all or nothing", import promises
// **nothing is trusted until it is verified**.
//
// The manifest is a document a stranger wrote, so three things are checked before any of its files are handed
// to the rest of the app:
//
// 1. it is a bundle this version understands (`validateCaseBundle` names what is wrong otherwise);
// 2. every name it describes is a single path segment — a manifest asking for `../../.ssh/id_rsa` is refused,
//    not normalised;
// 3. the bytes on disk hash to what the manifest claims, and the bundle carries no file the manifest does not
//    describe. Extra files are refused rather than ignored: a bundle that brings a passenger is not the bundle
//    the reader agreed to open.
//
// A bundle that fails any of these is reported as `incomplete` with the exact names — never partially imported.

export type CaseBundleImportProblem =
  | 'not-a-directory'
  | 'manifest-missing'
  | 'manifest-unreadable'
  | 'invalid-bundle'
  | 'files-missing'
  | 'bad-file-name'
  | 'incomplete'

export type CaseBundleContent = {
  manifest: CaseBundleManifest
  files: Array<CaseBundleFile & { path: string }>
  totalBytes: number
}

export type CaseBundleImportResult =
  | { ok: true; bundle: CaseBundleContent }
  | {
      ok: false
      problem: CaseBundleImportProblem
      detail?: string
      // For `incomplete`: the names that are missing, wrong, or unexpected, so the window can list them.
      problematic?: { missing: string[]; checksumMismatch: string[]; unexpected: string[] }
    }

const isSingleSegment = (name: string): boolean => {
  if (name.trim() === '' || name === '.' || name === '..') return false
  if (name.includes('/') || name.includes('\\')) return false
  for (const character of name) {
    if (character.codePointAt(0)! < 0x20) return false
  }
  return true
}

const sha256OfFile = async (path: string): Promise<string> =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex')

export const importCaseBundle = async (bundleDir: string): Promise<CaseBundleImportResult> => {
  const dirInfo = await stat(bundleDir).catch(() => undefined)
  if (!dirInfo || !dirInfo.isDirectory()) return { ok: false, problem: 'not-a-directory' }

  const manifestPath = join(bundleDir, CASE_BUNDLE_MANIFEST_NAME)
  const raw = await readFile(manifestPath, 'utf8').catch(() => undefined)
  if (raw === undefined) return { ok: false, problem: 'manifest-missing' }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (cause) {
    return {
      ok: false,
      problem: 'manifest-unreadable',
      detail: cause instanceof Error ? cause.message : String(cause)
    }
  }

  const checked = validateCaseBundle(parsed)
  if (!checked.ok) {
    return {
      ok: false,
      problem: 'invalid-bundle',
      detail: checked.detail ? `${checked.problem}: ${checked.detail}` : checked.problem
    }
  }
  const manifest = checked.manifest

  // Names are re-checked here even though the validator trimmed them: the validator's job is "is this document
  // shaped like a bundle", this module's job is "is it safe to touch the disk with".
  for (const file of manifest.files) {
    if (!isSingleSegment(file.name)) {
      return { ok: false, problem: 'bad-file-name', detail: file.name }
    }
  }

  const filesDir = join(bundleDir, CASE_BUNDLE_FILES_DIR)
  const entries = await readdir(filesDir).catch(() => undefined)
  if (!entries) return { ok: false, problem: 'files-missing' }

  const present: Array<{ name: string; sha256: string }> = []
  for (const name of entries) {
    const path = join(filesDir, name)
    const info = await stat(path).catch(() => undefined)
    if (!info || !info.isFile()) continue
    present.push({ name, sha256: await sha256OfFile(path) })
  }

  const reconciliation = reconcileCaseBundle(manifest, present)
  if (!caseBundleIsComplete(reconciliation)) {
    return {
      ok: false,
      problem: 'incomplete',
      problematic: {
        missing: reconciliation.missing,
        checksumMismatch: reconciliation.checksumMismatch,
        unexpected: reconciliation.unexpected
      }
    }
  }

  return {
    ok: true,
    bundle: {
      manifest,
      files: manifest.files.map((file) => ({ ...file, path: join(filesDir, file.name) })),
      totalBytes: manifest.files.reduce((sum, file) => sum + file.sizeBytes, 0)
    }
  }
}

// Copying a verified bundle into a destination: the bytes that land are the bytes that were hashed, because the
// copy happens only after `importCaseBundle` said the whole bundle is accounted for.
export type CaseBundleMaterialiseResult =
  | { ok: true; directory: string; fileCount: number; totalBytes: number }
  | { ok: false; problem: CaseBundleImportProblem | 'destination-unusable'; detail?: string }

export const materialiseCaseBundle = async (
  bundleDir: string,
  targetDir: string
): Promise<CaseBundleMaterialiseResult> => {
  const imported = await importCaseBundle(bundleDir)
  if (!imported.ok) return imported
  try {
    await mkdir(targetDir, { recursive: true })
    for (const file of imported.bundle.files) {
      await copyFile(file.path, join(targetDir, file.name))
    }
  } catch (cause) {
    return {
      ok: false,
      problem: 'destination-unusable',
      detail: cause instanceof Error ? cause.message : String(cause)
    }
  }
  return {
    ok: true,
    directory: targetDir,
    fileCount: imported.bundle.files.length,
    totalBytes: imported.bundle.totalBytes
  }
}
