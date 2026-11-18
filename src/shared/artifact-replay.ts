// Re-running a recorded artifact version and comparing the result with what it recorded producing.
//
// The request names a version the way every other provenance request does; the response carries the
// verdict, the origin the recipe came from, and whether the re-run ran in the recorded environment. Those
// three are kept apart on purpose: a report that merges them cannot be audited.
import type { ReplayEnvironmentComparison, ReplayRunOutcome } from './replay-verification'

export type ReplayVersionRequest = {
  projectId: string
  appSessionId: string
  artifactId: string
  versionId: string
  /** Bounds the re-run; a recording that takes longer than this is reported as timed out. */
  timeoutMs?: number
}

export type ReplayVersionResult = ReplayRunOutcome & {
  /**
   * Which of five named things is true about the environment — never a boolean. `not-recorded` and
   * `not-reported` mean the comparison could not be made, which is a different sentence from `drifted`.
   */
  environment: ReplayEnvironmentComparison
  /** Named so a caller never has to guess why nothing was compared. */
  stopped?: 'no-recorded-code' | 'version-unreadable' | 'not-configured'
}
