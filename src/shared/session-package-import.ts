// Importing a `.science` package is the receiving half of the portable-session contract, and the plan's
// rules are structural here rather than advisory:
//   · a package is PREVIEWED first and lands on disk only after an explicit confirmation;
//   · an imported session is READ-ONLY — its history can be read and cited, never executed or continued;
//   · its verification records are labelled as the SOURCE PARTY's assertions, because this machine did
//     not run them (the same fail-closed posture as the rest of the review/evidence surface);
//   · extraction is bounded: entry count, per-entry bytes and total bytes all have ceilings, so a hostile
//     or corrupt archive cannot exhaust the disk.
import type {
  SessionPackageAssertion,
  SessionPackageCounts,
  SessionPackageMode,
  SessionPackageNoteCode
} from './session-package'

// Hard ceilings for reading a package. Named here so the reader and any UI can state the same numbers.
export const SESSION_PACKAGE_LIMITS = Object.freeze({
  maxEntries: 5_000,
  maxEntryBytes: 64 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024
})

// What an imported session may be used for. Kept as a value so a caller cannot widen it by accident.
export const SESSION_PACKAGE_IMPORT_POSTURE = Object.freeze({
  readOnly: true,
  executeAllowed: false,
  continueAllowed: false,
  /** Where its verification records came from. Never this machine. */
  verificationLabel: 'source-party'
})

export type SessionPackageRejectionReason =
  // Not a zip / no manifest at all.
  | 'not-a-package'
  | 'manifest-invalid'
  | 'unsupported-format-version'
  // The manifest is intact but the package cannot be trusted to carry what it claims.
  | 'required-evidence-missing'
  | 'entry-path-unsafe'
  | 'entry-count-exceeded'
  | 'entry-too-large'
  | 'package-too-large'

export type SessionPackageImportPreview = {
  accepted: boolean
  /** Present only when the package was read far enough to describe it. */
  described?: {
    formatVersion: number
    mode: SessionPackageMode
    session: { id: string; title: string; projectId: string }
    counts: SessionPackageCounts
    assertion: SessionPackageAssertion
    notes: readonly SessionPackageNoteCode[]
  }
  /** Named when the package is refused; never a prose apology. */
  reason?: SessionPackageRejectionReason
}

export type SessionPackageImportRequest = {
  packagePath: string
  /** Import is a separate, explicit step: a preview can never write anything. */
  confirm?: { targetProjectId?: string }
}

export type SessionPackageImportResult =
  | {
      ok: true
      sessionId: string
      /** Always read-only, always source-party: a caller cannot ask for anything else. */
      posture: typeof SESSION_PACKAGE_IMPORT_POSTURE
      notes: readonly SessionPackageNoteCode[]
    }
  | { ok: false; reason: SessionPackageRejectionReason | 'not-confirmed' | 'write-failed' }
