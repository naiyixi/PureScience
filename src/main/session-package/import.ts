import { strFromU8, unzipSync } from 'fflate'

import {
  SESSION_PACKAGE_FORMAT_VERSION,
  SESSION_PACKAGE_MANIFEST_PATH,
  type SessionPackageManifest
} from '../../shared/session-package'
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
 * KNOWN LIMITATION (deliberate, not hidden): entries are decompressed with `unzipSync` before the
 * per-entry ceiling is applied, so `maxEntryBytes` catches an oversized entry *after* it was expanded.
 * The total-bytes ceiling is therefore enforced on what was actually produced, which bounds disk writes
 * but not peak memory. A streaming reader (`fflate.Unzip`) that refuses an entry the moment its declared
 * size exceeds the ceiling is the next step; until then this is a preview for packages the user chose,
 * not a hardened parser for hostile input.
 */
export const inspectSessionPackage = (archiveBytes: Uint8Array): SessionPackageImportPreview => {
  let entries: Record<string, Uint8Array>
  try {
    entries = unzipSync(archiveBytes)
  } catch {
    return refusal('not-a-package')
  }

  const names = Object.keys(entries)
  if (names.length > SESSION_PACKAGE_LIMITS.maxEntries) return refusal('entry-count-exceeded')

  let totalBytes = 0
  for (const name of names) {
    if (!isSafeEntryPath(name)) return refusal('entry-path-unsafe')
    const bytes = entries[name]
    if (bytes.byteLength > SESSION_PACKAGE_LIMITS.maxEntryBytes) return refusal('entry-too-large')
    totalBytes += bytes.byteLength
    if (totalBytes > SESSION_PACKAGE_LIMITS.maxTotalBytes) return refusal('package-too-large')
  }

  const manifestBytes = entries[SESSION_PACKAGE_MANIFEST_PATH]
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
    if (!entries[required]) return refusal('required-evidence-missing')
  }

  return {
    accepted: true,
    described: {
      formatVersion: manifest.formatVersion,
      mode: manifest.mode,
      session: {
        id: manifest.session.id,
        title: manifest.session.title,
        projectId: manifest.session.projectId
      },
      counts: manifest.counts,
      // Carried through verbatim: the reader must be able to show that these are the sender's claims.
      assertion: manifest.assertion,
      notes: manifest.notes ?? []
    }
  }
}
