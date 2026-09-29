// The desktop wire contract for exporting one Project as an RO-Crate 1.1 research object.
//
// The crate itself is decided elsewhere: the pure builder and its assertions live in `./ro-crate`, and
// the main-process byte writer lives in `src/main/ro-crate/export.ts`. This module only names what a
// window may ask for and what it gets back. Two rules shaped it:
//   · a refusal is a CODE, not prose — the reader's interface language is the renderer's business;
//   · a success carries what makes the export CHECKABLE (where the crate landed, how many files, and the
//     validation verdict the writer already computed against the bytes it wrote), so the window reports
//     a result instead of a promise.

export const RO_CRATE_EXPORT_CHANNEL = 'ro-crate:export-project'

/** The software identity every crate records as its producer. */
export const RO_CRATE_EXPORT_SOFTWARE = Object.freeze({
  name: 'PureScience',
  url: 'https://www.zerolink.com/purescience'
})

/** What a window asks for. Without `destinationPath` the desktop save dialog supplies one. */
export type RoCrateExportRequest = {
  projectId: string
  /** Directory the crate is written into. Picked in the desktop save dialog when this is absent. */
  destinationPath?: string
}

/** Why one published Artifact Version did not make it into the crate. Mirrors the writer's own codes. */
export type RoCrateExportRefusalReason =
  'evidence-unreadable' | 'evidence-invalid' | 'content-missing' | 'checksum-mismatch'

export type RoCrateExportRefusedVersion = {
  appSessionId: string
  artifactId: string
  versionId: string
  reason: RoCrateExportRefusalReason
}

// Named refusals, never prose. `cancelled` is the desktop dialog's way of not producing a crate; the
// rest each say what stood in the way, so the window can name the reason instead of apologising.
export type RoCrateExportFailure =
  | 'cancelled'
  | 'project-not-found'
  /** The Project has published nothing yet: there is no Version to describe. */
  | 'no-published-version'
  /** Versions exist, but every one of them was refused — their recorded provenance no longer matches. */
  | 'no-exportable-version'
  | 'destination-unwritable'
  | 'validation-failed'
  | 'write-failed'

export type RoCrateExportSuccess = {
  ok: true
  /** Directory that now holds the crate: `ro-crate-metadata.json` plus `files/`. */
  outputDir: string
  metadataPath: string
  /** How many payload files were copied in — the number of File entities in the metadata. */
  fileCount: number
  /** Total byte length of those payload files, as re-measured after writing. */
  totalBytes: number
  /** The writer's own verdict, from the same assertions the crate is validated against. */
  validation: Readonly<{ passed: number; failed: number }>
  /** Published Versions the writer refused because their bytes no longer hashed to the record. */
  refusedCount: number
  refused: readonly RoCrateExportRefusedVersion[]
}

export type RoCrateExportRefusal = {
  ok: false
  error: RoCrateExportFailure
  /** Free-text detail for a log or a support bundle. Never the only thing shown to a person. */
  detail?: string
  /** For `no-exportable-version`: exactly which Versions were refused, and why. */
  refused?: readonly RoCrateExportRefusedVersion[]
}

export type RoCrateExportResult = RoCrateExportSuccess | RoCrateExportRefusal
