import { createHash } from 'node:crypto'

import { strToU8, zipSync } from 'fflate'

import {
  SESSION_PACKAGE_ASSERTION,
  SESSION_PACKAGE_FORMAT_VERSION,
  SESSION_PACKAGE_MANIFEST_PATH,
  SESSION_PACKAGE_ALWAYS_INCLUDED,
  type SessionPackageCounts,
  type SessionPackageEntry,
  type SessionPackageManifest,
  type SessionPackageMode,
  type SessionPackageNoteCode
} from '../../shared/session-package'

// A single file that would bloat the package is named and left out rather than silently dropped or
// silently included. 25 MB keeps an essential package mailable while still carrying figures.
export const DEFAULT_SESSION_PACKAGE_MAX_FILE_BYTES = 25 * 1024 * 1024

export type SessionPackageFile = {
  /** Path inside the package, e.g. `files/figures/figA.png`. */
  path: string
  contents: Uint8Array
}

export type SessionPackageInput = {
  session: { id: string; title: string; projectName: string }
  appVersion: string
  exportedAt?: string
  /** Required evidence — always written, in both modes. */
  conversation: unknown
  citations: readonly unknown[]
  reviewFindings: readonly unknown[]
  verificationRecords: readonly unknown[]
  files?: readonly SessionPackageFile[]
  environment?: unknown
  reproductionOutputs?: readonly SessionPackageFile[]
  maxFileBytes?: number
}

export type SessionPackageResult = {
  archive: Uint8Array
  manifest: SessionPackageManifest
}

const sha256 = (contents: Uint8Array): string => createHash('sha256').update(contents).digest('hex')

// Paths are written straight into a zip: keep them relative and free of traversal so an archive can
// never escape the directory a reader extracts into.
const normalizeEntryPath = (path: string): string => {
  const cleaned = path.replace(/\\/g, '/').replace(/^\/+/, '')
  const parts = cleaned.split('/').filter((part) => part.length > 0 && part !== '.')
  if (parts.includes('..')) throw new Error(`Package entry path escapes the archive root: ${path}`)
  if (parts.length === 0) throw new Error(`Package entry path is empty: ${path}`)
  return parts.join('/')
}

export const createSessionPackage = (
  input: SessionPackageInput,
  mode: SessionPackageMode
): SessionPackageResult => {
  const maxFileBytes = input.maxFileBytes ?? DEFAULT_SESSION_PACKAGE_MAX_FILE_BYTES
  const notes: SessionPackageNoteCode[] = []
  const entries: SessionPackageEntry[] = []
  const write: Record<string, Uint8Array> = {}

  const addJson = (path: string, value: unknown): void => {
    const contents = strToU8(`${JSON.stringify(value, null, 2)}\n`)
    const normalized = normalizeEntryPath(path)
    write[normalized] = contents
    entries.push({ path: normalized, bytes: contents.byteLength, sha256: sha256(contents) })
  }

  // Required evidence: present in both modes, by construction.
  addJson('conversation.json', input.conversation)
  addJson('evidence/citations.json', input.citations)
  addJson('evidence/review-findings.json', input.reviewFindings)
  addJson('evidence/verifications.json', input.verificationRecords)

  const candidateFiles: SessionPackageFile[] = [...(input.files ?? [])]
  let fileCount = 0

  if (mode === 'full') {
    for (const file of candidateFiles) {
      const normalized = normalizeEntryPath(file.path)
      if (file.contents.byteLength > maxFileBytes) {
        const note: SessionPackageNoteCode = `file-omitted-too-large:${normalized}`
        notes.push(note)
        entries.push({
          path: normalized,
          bytes: file.contents.byteLength,
          sha256: sha256(file.contents),
          omitted: true,
          note
        })
        continue
      }
      write[normalized] = file.contents
      entries.push({
        path: normalized,
        bytes: file.contents.byteLength,
        sha256: sha256(file.contents)
      })
      fileCount += 1
    }

    if (input.environment === undefined) {
      notes.push('environment-lock-unavailable')
    } else {
      addJson('environment.json', input.environment)
    }

    if ((input.reproductionOutputs ?? []).length === 0) {
      notes.push('reproduction-outputs-unavailable')
    } else {
      for (const output of input.reproductionOutputs ?? []) {
        const normalized = normalizeEntryPath(output.path)
        write[normalized] = output.contents
        entries.push({
          path: normalized,
          bytes: output.contents.byteLength,
          sha256: sha256(output.contents)
        })
      }
    }
  } else if (candidateFiles.length > 0) {
    // Essential packages carry the conversation and the evidence, not the files — say so by name.
    notes.push(`files-not-requested:${candidateFiles.length}`)
  }

  const counts: SessionPackageCounts = {
    messages: Array.isArray(input.conversation)
      ? input.conversation.length
      : ((input.conversation as { messages?: unknown[] } | undefined)?.messages?.length ?? 0),
    citations: input.citations.length,
    reviewFindings: input.reviewFindings.length,
    verificationRecords: input.verificationRecords.length,
    files: fileCount
  }

  const manifest: SessionPackageManifest = {
    formatVersion: SESSION_PACKAGE_FORMAT_VERSION,
    mode,
    exportedAt: input.exportedAt ?? new Date().toISOString(),
    app: { version: input.appVersion },
    session: input.session,
    counts,
    entries: entries.sort((left, right) => left.path.localeCompare(right.path)),
    assertion: { ...SESSION_PACKAGE_ASSERTION },
    notes
  }

  // The manifest is written last so it can describe every other entry, then re-added with itself.
  const manifestEntry = strToU8(`${JSON.stringify(manifest, null, 2)}\n`)
  write[SESSION_PACKAGE_MANIFEST_PATH] = manifestEntry

  const archive = zipSync(write, { level: 6 })

  // A reader must be able to see all four evidence kinds without unpacking anything else.
  const evidencePaths = [
    'conversation.json',
    'evidence/citations.json',
    'evidence/review-findings.json',
    'evidence/verifications.json'
  ]
  for (const path of evidencePaths) {
    if (!write[path]) throw new Error(`Session package dropped required evidence: ${path}`)
  }
  if (SESSION_PACKAGE_ALWAYS_INCLUDED.length !== evidencePaths.length) {
    throw new Error('Session package evidence list and written evidence disagree.')
  }

  return { archive, manifest }
}
