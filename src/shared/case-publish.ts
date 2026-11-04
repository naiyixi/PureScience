// Publishing side of the case market. Two halves that must not be confused:
//
//   * the local half — a project's files become the same bundle the export button produces, then one archive, then
//     one SHA-256. This is measurable on this machine and cannot lie.
//   * the remote half — the archive is uploaded to this repository's `case-index` release and one line is added to
//     the index. This half needs a credential, and the only credential we accept is the one `gh` already holds: the
//     app does not collect a GitHub token of its own and does not invent an OAuth app to get one.
//
// The index is edited by upserting the published case's own entry and leaving every other entry byte-for-byte as it
// was. A publisher who breaks their case cannot break the shelf.

import type { CaseBundleFileRequest } from './case-bundle'
import type { CaseMarketplaceIndex } from './case-marketplace'

export const CASE_PUBLISH_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
export const CASE_PUBLISH_RELEASE_TAG = 'case-index'
export const CASE_PUBLISH_INDEX_ASSET = 'case-marketplace.json'

/** What the publisher has to write themselves. Nothing here is inferred from the project. */
export type CasePublishDraft = {
  /** Stable identity. Re-publishing the same id replaces that entry and leaves the rest alone. */
  id: string
  name: string
  domain: string
  summary: string
  author: string
  /** OSI short name, or "proprietary". */
  license: string
  minAppVersion?: string
}

export type CasePublishRequest = {
  projectId: string
  draft: CasePublishDraft
  /** The same file identities the export request carries; the main process resolves them itself. */
  files?: ReadonlyArray<CaseBundleFileRequest>
}

export type CasePublishProblem =
  | 'no-files'
  | 'bad-file-name'
  | 'too-many-files'
  | 'duplicate-file-name'
  | 'export-failed'
  | 'pack-failed'
  | 'bad-id'
  | 'missing-metadata'
  | 'no-credential'
  | 'release-failed'
  | 'upload-failed'
  | 'index-unreachable'
  | 'index-unreadable'
  | 'index-upload-failed'
  | 'verify-failed'

export type CasePublishOutcome =
  | {
      status: 'published'
      id: string
      fileCount: number
      totalBytes: number
      bundleSha256: string
      archiveBytes: number
      indexUrl: string
      /** True only after the index was read back off the release and the entry carried this digest. */
      verified: true
    }
  | { status: 'refused'; reason: CasePublishProblem; detail?: string }

/** The document as it is uploaded: the same shape the reader validates, nothing added. */
export type CasePublishIndex = CaseMarketplaceIndex
