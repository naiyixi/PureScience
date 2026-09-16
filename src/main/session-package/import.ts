import { strFromU8 } from 'fflate'

import {
  SESSION_PACKAGE_FORMAT_VERSION,
  SESSION_PACKAGE_MANIFEST_PATH,
  type SessionPackageManifest
} from '../../shared/session-package'
import { readZipDirectory } from './zip-directory'
import { readZipEntries } from './zip-reader'

import { verifySessionPackageIntegrity } from './integrity'
import {
  SESSION_PACKAGE_LIMITS,
  type SessionPackageImportPreview,
  type SessionPackageRejectionReason
} from '../../shared/session-package-import'

// Evidence a package cannot be imported without. The exporter writes all four in every mode, so a
// package missing one is either hand-made or damaged — both are refused rather than half-imported.
export const REQUIRED_PACKAGE_EVIDENCE = [
  'conversation.json',
  'evidence/citations.json',
  'evidence/review-findings.json',
  'evidence/verifications.json'
] as const

const refusal = (reason: SessionPackageRejectionReason): SessionPackageImportPreview => ({
  accepted: false,
  reason
})

const isSafeEntryPath = (name: string): boolean =>
  name.length > 0 &&
  !name.startsWith('/') &&
  !name.startsWith('\\') &&
  !name.split('/').includes('..')

/**
 * Read a package far enough to say whether it may be imported, and what it holds.
 *
 * The ceilings are applied to what the archive DECLARES before anything is expanded: the central
 * directory is read first, and an oversized member, an unsafe path or an over-long entry list is refused
 * without decompressing a byte. Zip64 members (whose sizes hide in an extra field this reader does not
 * interpret) are refused by name rather than expanded unbounded — our exporter never writes them.
 */
export const inspectSessionPackage = (archiveBytes: Uint8Array): SessionPackageImportPreview => {
  // 1. What the archive CLAIMS, read from its directory without expanding anything.
  const directory = readZipDirectory(archiveBytes)
  if (!directory.ok) {
    return refusal(directory.reason === 'zip64-not-admitted' ? 'entry-too-large' : 'not-a-package')
  }
  if (directory.entries.length > SESSION_PACKAGE_LIMITS.maxEntries) {
    return refusal('entry-count-exceeded')
  }
  let declaredTotal = 0
  for (const entry of directory.entries) {
    if (!isSafeEntryPath(entry.name)) return refusal('entry-path-unsafe')
    if (entry.declaredBytes > SESSION_PACKAGE_LIMITS.maxEntryBytes)
      return refusal('entry-too-large')
    declaredTotal += entry.declaredBytes
    if (declaredTotal > SESSION_PACKAGE_LIMITS.maxTotalBytes) return refusal('package-too-large')
  }

  // 2. Only then expand — one member at a time, under the same ceilings, and with the size a member
  // ACTUALLY inflates to checked as it grows (a declaration can understate it).
  const expanded = readZipEntries(archiveBytes, SESSION_PACKAGE_LIMITS)
  if (!expanded.ok) {
    return refusal(expanded.reason === 'zip64-not-admitted' ? 'entry-too-large' : expanded.reason)
  }
  const entries = expanded.entries
  const names = [...entries.keys()]
  if (names.length > SESSION_PACKAGE_LIMITS.maxEntries) return refusal('entry-count-exceeded')

  let totalBytes = 0
  for (const name of names) {
    if (!isSafeEntryPath(name)) return refusal('entry-path-unsafe')
    const bytes = entries.get(name) as Uint8Array
    if (bytes.byteLength > SESSION_PACKAGE_LIMITS.maxEntryBytes) return refusal('entry-too-large')
    totalBytes += bytes.byteLength
    if (totalBytes > SESSION_PACKAGE_LIMITS.maxTotalBytes) return refusal('package-too-large')
  }

  const manifestBytes = entries.get(SESSION_PACKAGE_MANIFEST_PATH)
  if (!manifestBytes) return refusal('not-a-package')

  let manifest: SessionPackageManifest
  try {
    manifest = JSON.parse(strFromU8(manifestBytes)) as SessionPackageManifest
  } catch {
    return refusal('manifest-invalid')
  }

  if (
    !manifest ||
    typeof manifest !== 'object' ||
    typeof manifest.formatVersion !== 'number' ||
    typeof manifest.session !== 'object' ||
    manifest.session === null ||
    typeof manifest.assertion !== 'object' ||
    manifest.assertion === null
  ) {
    return refusal('manifest-invalid')
  }

  if (manifest.formatVersion !== SESSION_PACKAGE_FORMAT_VERSION) {
    return refusal('unsupported-format-version')
  }

  for (const required of REQUIRED_PACKAGE_EVIDENCE) {
    if (!entries.has(required)) return refusal('required-evidence-missing')
  }

  return {
    accepted: true,
    // The record is checked against the bytes here, where both are in hand: an accepted package is one
    // an importer has looked at, not one it has taken on faith.
    integrity: verifySessionPackageIntegrity(manifest, entries),
    described: {
      formatVersion: manifest.formatVersion,
      mode: manifest.mode,
      session: {
        id: manifest.session.id,
        title: manifest.session.title,
        projectId: manifest.session.projectId
      },
      appVersion: manifest.app?.version ?? '',
      exportedAt: manifest.exportedAt ?? '',
      counts: manifest.counts,
      // Carried through verbatim: the reader must be able to show that these are the sender's claims.
      assertion: manifest.assertion,
      notes: manifest.notes ?? []
    }
  }
}
