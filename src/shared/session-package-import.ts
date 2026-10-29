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
import type { ReplayReport } from './replay-verification'
import type { SessionPackageUsageComparison } from './session-package-usage'
import type { SessionPackageToolReadings, ToolCallReadingsComparison } from './tool-call-readings'

/**
 * 一个包「与自己带来的字节核对过什么」的结论：成本摘要与工具调用读数，各自逐字段。
 *
 * 为什么它是导入结果的一部分而不是只在预览里说一句：接收方要能**事后**回答「这个包里的数字，
 * 在这台机器上复算过没有、哪几项对上了」。写进结果与导入记录，重启后仍然可读；只放在一次性的
 * 预览里，就等于要求用户当场记住。
 *
 * 三种状态都保留原名（match / not-recorded / underivable / mismatch），绝不压成一句「一致」：
 * 「老包没有这段」与「复算后一致」是两件事。
 */
export type SessionPackageImportReadings = {
  usage: SessionPackageUsageComparison
  toolCalls: ToolCallReadingsComparison
  /**
   * 清单里那句工具读数声明，原样带出。
   *
   * 必须与 `toolCalls` 一起读：`match` 只说明「声明与包内字节一致」，而声明本身可能是「这次没调
   * 工具」或「这一版导出器没采这一段」。只看到一个 `match` 会被读成「核对过 N 条」，那正是本文件
   * 反复禁止的「把缺席说成没有」。老包没有这段声明时省略。
   */
  toolCallsDeclared?: SessionPackageToolReadings
}

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
  // A required evidence member is present but is not the JSON list its kind requires.
  | 'evidence-unreadable'
  | 'entry-path-unsafe'
  | 'entry-count-exceeded'
  | 'entry-too-large'
  | 'package-too-large'

export type SessionPackageImportPreview = {
  accepted: boolean
  /**
   * The record-vs-bytes check on the package itself: whether every packaged member still hashes to the
   * digest the exporter wrote for it. `record-integrity` vocabulary — an intact package was not
   * re-run, it was read back, and the two must not be reported as the same thing.
   */
  integrity?: ReplayReport
  /**
   * The file this preview described, when one was resolved. The confirm step names the same file, so the
   * reader cannot preview one package and import another by accident.
   */
  packagePath?: string
  /** Present only when the package was read far enough to describe it. */
  described?: {
    formatVersion: number
    mode: SessionPackageMode
    session: { id: string; title: string; projectId: string }
    /** Who exported it and when — provenance an import must keep, not invent. */
    appVersion: string
    exportedAt: string
    counts: SessionPackageCounts
    assertion: SessionPackageAssertion
    notes: readonly SessionPackageNoteCode[]
    /**
     * 包里带的工具调用读数（已与包内字节核对一致才会走到 accepted 这里）。缺席态的两种说法
     * 分别是「这次没调工具」与「老包没带这一段」—— 界面要分开讲，别合成一句「没有」。
     */
    toolReadings?: SessionPackageToolReadings
    /** 逐字段复算的结论：成本摘要 + 工具调用读数，都是对着包内字节算的。 */
    readings: SessionPackageImportReadings
  }
  /** Named when the package is refused; never a prose apology. */
  reason?: SessionPackageRejectionReason
}

export type SessionPackageImportRequest = {
  packagePath: string
  /** Import is a separate, explicit step: a preview can never write anything. */
  confirm?: { targetProjectId?: string }
}

/**
 * What actually became rows on this machine.
 *
 * Counted separately from the package's own counts on purpose: a package can carry a row this machine
 * will not land (a citation key the target project already uses, a block that is not in the transcript
 * it arrived with), and repeating the carried number would claim a row that is not there.
 */
export type SessionPackageEvidenceLanding = {
  citations: number
  reviews: number
  reviewFindings: number
  verificationRecords: number
  /** Every row that did not land, with the name of the reason. Never silently dropped. */
  skipped: readonly SessionPackageEvidenceSkip[]
}

/** The three evidence kinds a package carries besides the conversation. */
export type SessionPackageEvidenceKind = 'citations' | 'review-findings' | 'verifications'

/** Named reasons a packaged evidence row did not become a row here. Codes, not prose. */
export type SessionPackageEvidenceSkipReason =
  // The row is not the shape its kind requires (missing identity or wrong field types).
  | 'row-unreadable'
  // The citation's key is already used in the target project, so landing it would collide.
  | 'reference-key-taken'
  // The review this row belongs to was itself not landed, so there is nothing to hang it on.
  | 'review-not-imported'
  // The row points at a message that is not in the imported transcript.
  | 'message-not-found'
  // The stored block is truncated, so no faithful fingerprint of it can be computed.
  | 'text-truncated'
  // The session could not be read while re-deriving a pin's fingerprint.
  | 'session-unavailable'
  // The store refused the write.
  | 'landing-failed'

export type SessionPackageEvidenceSkip = {
  kind: SessionPackageEvidenceKind
  reason: SessionPackageEvidenceSkipReason
  /** The row's own identity, when it carried one. */
  id?: string
}

export type SessionPackageImportResult =
  | {
      ok: true
      sessionId: string
      /** Always read-only, always source-party: a caller cannot ask for anything else. */
      posture: typeof SESSION_PACKAGE_IMPORT_POSTURE
      notes: readonly SessionPackageNoteCode[]
      /** What the package's evidence became on this machine. */
      landed: SessionPackageEvidenceLanding
      /**
       * 导入时对着包内字节复算过的结论（成本摘要 / 工具调用读数）。
       *
       * 与 `landed` 分开：`landed` 说的是「哪些行进了这台机器的库」，这里说的是「包里的自述数字
       * 与它自己带来的字节是否对得上」。两件事都会有一个不是「是」的答案，合成一句就会丢掉一个。
       */
      readings: SessionPackageImportReadings
    }
  | {
      ok: false
      reason: SessionPackageRejectionReason | 'not-confirmed' | 'no-target-project' | 'write-failed'
    }

/**
 * What travels alongside an imported session, so the read-only posture and the sender's own claim about
 * provenance survive a restart instead of living only in the process that did the import.
 */
export type SessionPackageImportRecord = {
  importedAt: string
  /** The identity the package carried. The imported session gets a NEW id; this is where it came from. */
  importedFrom: {
    sessionId: string
    projectId: string
    appVersion: string
    exportedAt: string
  }
  posture: typeof SESSION_PACKAGE_IMPORT_POSTURE
  /** The sender's provenance claim, verbatim. Never rewritten into this machine's voice. */
  assertion: SessionPackageAssertion
  notes: readonly SessionPackageNoteCode[]
  /**
   * 这次导入复算过的结论。可选：本字段之前的记录没有它，缺它就是「没复算过」，绝不能读成一致。
   */
  readings?: SessionPackageImportReadings
}

/** Suffix for the sidecar file that carries the record above next to an imported session. */
export const SESSION_PACKAGE_IMPORT_RECORD_SUFFIX = '.import.json'

/**
 * The refusal an imported session gives when something tries to run it. Its history can be read and
 * cited, never executed or continued: this machine did not run that work, and the record beside the
 * session is what says so.
 */
export const SESSION_PACKAGE_IMPORT_READ_ONLY_MESSAGE =
  'This session was imported from a session package and is read-only: it can be read and cited, not run.'
