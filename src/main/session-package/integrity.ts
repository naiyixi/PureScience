import { createHash } from 'node:crypto'

import {
  compareReplayOutputs,
  type ReplayReport,
  type SealedFileDigest
} from '../../shared/replay-verification'
import {
  SESSION_PACKAGE_MANIFEST_PATH,
  type SessionPackageManifest
} from '../../shared/session-package'

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

const SESSION_PACKAGE_RECIPE_FORMAT_VERSION = 1

/**
 * Checks a package's own record against its own bytes.
 *
 * An export writes a digest for every entry it packs, and until now nothing ever read those digests
 * back: a package could be truncated, patched or rebuilt in transit and the manifest would still say
 * what it said when it was written. This closes that gap — and only that gap.
 *
 * Two things it deliberately does NOT claim:
 *   * it is not reproducibility. These bytes were not produced by re-running anything; they are being
 *     compared with the record the exporter wrote (`record-integrity`), so the verdict vocabulary is
 *     "intact / changed", never "reproduced";
 *   * it says nothing about the app version that wrote the package. A record is compared with itself,
 *     so there is no second environment that could differ; the exporter's version rides along for the
 *     reader to see, not as part of the comparison.
 */
export const verifySessionPackageIntegrity = (
  manifest: Pick<SessionPackageManifest, 'entries' | 'app'>,
  entries: ReadonlyMap<string, Uint8Array>
): ReplayReport => {
  const recorded = manifest.entries ?? []
  const declaredVersion = manifest.app?.version ?? ''

  const currentOutputs: SealedFileDigest[] = recorded
    .filter((entry) => !entry.omitted && entries.has(entry.path))
    .map((entry): SealedFileDigest => {
      // Copied into a plain view: the entries map is typed as backing-store-agnostic, and a Buffer over
      // a shared ArrayBuffer is the kind of aliasing this check should not be quietly exposed to.
      const bytes = new Uint8Array(entries.get(entry.path) as Uint8Array)
      return {
        path: entry.path,
        sha256: sha256(bytes),
        sizeBytes: bytes.byteLength,
        // The bytes themselves, so a difference is reported with the offset it starts at rather than as
        // an unlocatable "this file is not what it was".
        bytes: Buffer.from(bytes).toString('base64')
      }
    })
    // An omitted member is declared and simply not there — answering "missing" would accuse the package
    // of losing something it never carried. No digest on either side reads as unchecked.
    .concat(
      recorded
        .filter((entry) => entry.omitted)
        .map((entry): SealedFileDigest => ({ path: entry.path, sha256: '', sizeBytes: 0 }))
    )

  const report = compareReplayOutputs(
    {
      formatVersion: SESSION_PACKAGE_RECIPE_FORMAT_VERSION as 1,
      appVersion: declaredVersion,
      origin: 'executed',
      inputs: [],
      outputs: recorded.map((entry) => ({
        path: entry.path,
        // An omitted entry records no digest by construction, which the comparator reports as an
        // unchecked file rather than as a match. That is the intended outcome: part of the package was
        // left out, so part of it cannot be vouched for.
        sha256: entry.omitted ? '' : entry.sha256,
        sizeBytes: entry.bytes
      }))
    },
    { appVersion: declaredVersion, outputs: currentOutputs },
    'record-integrity'
  )

  // A packaged member that the manifest never mentions is still a member: said out loud, not ignored.
  // The manifest itself is the record being checked against, not one of the things it records — counting
  // it as undeclared would make every well-formed package fail its own check.
  const declaredPaths = new Set(recorded.map((entry) => entry.path))
  const undeclared = [...entries.keys()].filter(
    (path) => !declaredPaths.has(path) && path !== SESSION_PACKAGE_MANIFEST_PATH
  )
  if (undeclared.length === 0) return report

  return {
    ...report,
    verdict: report.verdict === 'intact' ? 'changed' : report.verdict,
    files: [...report.files, ...undeclared.map((path) => ({ path, status: 'extra' as const }))],
    reasons: [
      ...report.reasons,
      ...undeclared.map((path) => `${path}: packed without being declared in the manifest`)
    ]
  }
}
