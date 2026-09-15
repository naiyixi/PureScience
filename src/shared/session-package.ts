// The portable session package (`.science`): a session's conversation plus the evidence and the
// conclusions a second machine needs to judge the work — without ever letting the sender's claims
// masquerade as the receiver's own verification.
//
// Two rules are structural here, not advisory:
//   · required evidence (conversation, citations, review findings, verification records) is included
//     in EVERY mode, including `essential`. A package without its evidence is not a package.
//   · everything inside is the SOURCE PARTY's assertion. `locallyVerified` is pinned to `false` by the
//     type, so no package can claim a verification this machine did not run.
export const SESSION_PACKAGE_EXTENSION = '.science'
export const SESSION_PACKAGE_MANIFEST_PATH = 'manifest.json'
export const SESSION_PACKAGE_FORMAT_VERSION = 1

export type SessionPackageMode = 'essential' | 'full'

export type SessionPackageEvidenceKind =
  'conversation' | 'citations' | 'review-findings' | 'verifications'

// Carried in both modes. `full` adds the files, the environment lock and the reproduction outputs.
export const SESSION_PACKAGE_ALWAYS_INCLUDED: readonly SessionPackageEvidenceKind[] = [
  'conversation',
  'citations',
  'review-findings',
  'verifications'
]

// Named reasons a package can be smaller than the session it describes. Codes, not prose: the reader's
// interface language is the receiver's business.
export type SessionPackageNoteCode =
  | `file-omitted-too-large:${string}`
  | `files-not-requested:${number}`
  | `environment-lock-unavailable`
  | `reproduction-outputs-unavailable`

export type SessionPackageAssertion = {
  /** Every claim in this package was produced by the exporting machine. */
  origin: 'source-party'
  /** Pinned false: a package can never carry local verification for the importing machine. */
  locallyVerified: false
}

export type SessionPackageCounts = {
  messages: number
  citations: number
  reviewFindings: number
  verificationRecords: number
  files: number
}

export type SessionPackageEntry = {
  path: string
  bytes: number
  sha256: string
  /** Present on entries the sender named but did not carry (bounded packages stay honest). */
  omitted?: true
  note?: SessionPackageNoteCode
}

export type SessionPackageManifest = {
  formatVersion: number
  mode: SessionPackageMode
  exportedAt: string
  app: { version: string }
  session: { id: string; title: string; projectName: string }
  counts: SessionPackageCounts
  entries: SessionPackageEntry[]
  assertion: SessionPackageAssertion
  notes: SessionPackageNoteCode[]
}

/** The one assertion every manifest must carry. Kept as a value so producers cannot vary it. */
export const SESSION_PACKAGE_ASSERTION: SessionPackageAssertion = Object.freeze({
  origin: 'source-party',
  locallyVerified: false
})
