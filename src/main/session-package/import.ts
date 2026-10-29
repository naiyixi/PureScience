import { strFromU8 } from 'fflate'

import {
  SESSION_PACKAGE_FORMAT_VERSION,
  SESSION_PACKAGE_MANIFEST_PATH,
  type SessionPackageManifest
} from '../../shared/session-package'
import {
  compareSessionPackageUsage,
  deriveSessionPackageUsage
} from '../../shared/session-package-usage'
import { readZipDirectory } from './zip-directory'
import { readZipEntries } from './zip-reader'
import { verifyToolCallReadings } from './tool-readings'
import { SESSION_PACKAGE_TOOL_READINGS_PATH } from '../../shared/tool-call-readings'

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

  // 3. The manifest's cost summary is recomputed from the transcript that actually travelled. The
  //    numbers are part of what an importer is asked to believe, so they are checked here rather than
  //    trusted: a summary that disagrees with the package's own bytes is an invalid manifest, and so is
  //    a summary whose transcript cannot be read at all. A package that carries no summary (written
  //    before this check existed) is accepted — absence is reported as `not-recorded`, never as a match.
  let conversation: unknown
  try {
    conversation = JSON.parse(strFromU8(entries.get('conversation.json') as Uint8Array))
  } catch {
    return refusal('manifest-invalid')
  }
  const usage = compareSessionPackageUsage(manifest.usage, deriveSessionPackageUsage(conversation))
  if (usage.state === 'mismatch' || usage.state === 'underivable')
    return refusal('manifest-invalid')

  // 4. 工具调用读数：清单里的行数 / 未命名活动数 / 字节摘要，逐条对回包内那份文件的**原始字节**。
  //    对不上就是「这个包与它自己的记录不符」，与 usage 的处理一致；老包没有这一段则读作
  //    `not-recorded`，继续导入，但永远不算作「已验证一致」。
  const toolReadings = verifyToolCallReadings(
    manifest.toolReadings,
    entries.get(SESSION_PACKAGE_TOOL_READINGS_PATH)
  )
  if (toolReadings.state === 'mismatch' || toolReadings.state === 'underivable') {
    return refusal('manifest-invalid')
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
      notes: manifest.notes ?? [],
      // Already checked against the bytes above; the reader shows it as a reading, not as a promise.
      ...(manifest.toolReadings ? { toolReadings: manifest.toolReadings } : {}),
      // The conclusion itself travels with the description: what was recomputed, field by field, and how
      // it came out. A caller that only sees the package path can read the verdict instead of re-deriving
      // it (and, importantly, instead of assuming that acceptance meant agreement).
      readings: {
        usage,
        toolCalls: toolReadings,
        ...(manifest.toolReadings ? { toolCallsDeclared: manifest.toolReadings } : {})
      }
    }
  }
}
