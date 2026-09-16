// Reproducibility, stated as something a machine can check.
//
// The claim "this result reproduces" is only worth anything if it is falsifiable, so the rule here is
// narrow and total: a replayed run is `reproduced` when — and only when — every comparable output is
// byte-identical, nothing is missing, and nothing was left uncomparable. Anything else is reported as
// what it is, with a named reason, and never rounded up to "reproduced".
//
// Two properties are structural rather than advisory:
//   * a recipe whose steps were *reconstructed by a model* can never yield `reproduced`. Inferred code
//     is a hypothesis about what ran, not a record of it, and the verdict says so in the type system
//     (see `ReplayOrigin`) instead of relying on a report to be careful;
//   * a comparison that could not be made is a first-class outcome (`not-comparable`) with a reason, so
//     "we did not check this" can never be mistaken for "this matched".
export const REPLAY_RECIPE_FORMAT_VERSION = 1

/** Where a recipe's steps came from. Only `executed` describes something that actually ran. */
export type ReplayOrigin = 'executed' | 'reconstructed'

export type SealedFileDigest = {
  /** Workspace-relative path, the identity a comparison is keyed by. */
  path: string
  sha256: string
  sizeBytes: number
  /** The bytes themselves for the replay, absent when only the digest was captured. */
  bytes?: string
}

export type SealedRecipe = {
  formatVersion: typeof REPLAY_RECIPE_FORMAT_VERSION
  /** Application version the recipe was captured under; a different one is reported, not assumed equal. */
  appVersion: string
  origin: ReplayOrigin
  inputs: readonly SealedFileDigest[]
  outputs: readonly SealedFileDigest[]
  /** Opaque environment lock reference (interpreter/package set), absent when none was captured. */
  environmentLockRef?: string
}

export type ReplayRunResult = {
  appVersion: string
  outputs: readonly SealedFileDigest[]
}

export type FileVerdict =
  | { path: string; status: 'match' }
  | {
      path: string
      status: 'differs'
      firstDifferingByte: number
      originalBytes: number
      replayBytes: number
    }
  | { path: string; status: 'missing' }
  | { path: string; status: 'extra' }
  | { path: string; status: 'not-comparable'; reason: NotComparableReason }

export type NotComparableReason =
  | 'no-digest-recorded'
  | 'size-beyond-comparison-bound'
  | 'app-version-mismatch'
  | 'unsupported-output-kind'

/**
 * What was actually checked. A re-run is evidence about reproducibility; re-reading the files a version
 * recorded is evidence about *integrity* — that the record still describes the bytes. They are different
 * claims, so they get different words and neither can be reported as the other.
 */
export type ReplayMode = 're-run' | 'record-integrity'

export type ReplayVerdict =
  /** mode `re-run`: every comparable output came back byte-identical. */
  | 'reproduced'
  /** mode `record-integrity`: the recorded digests still match the bytes on disk. */
  | 'intact'
  | 'differs'
  | 'changed'
  | 'unverifiable'

export type ReplayReport = {
  mode: ReplayMode
  verdict: ReplayVerdict
  origin: ReplayOrigin
  files: readonly FileVerdict[]
  /** Plain-language reasons, in the order the files were compared. Never empty for a non-reproduced run. */
  reasons: readonly string[]
}

/** Above this size the byte-level comparison would read more than a verification is worth. */
export const MAX_BYTE_COMPARISON_BYTES = 64 * 1024 * 1024

const firstDifferingByte = (original: string, replay: string): number => {
  const originalBytes = Buffer.from(original, 'base64')
  const replayBytes = Buffer.from(replay, 'base64')
  const limit = Math.min(originalBytes.length, replayBytes.length)
  for (let index = 0; index < limit; index += 1) {
    if (originalBytes[index] !== replayBytes[index]) return index
  }
  return limit
}

/**
 * Compares a replayed run against the sealed recipe, file by file. When the recipe carries bytes the
 * comparison is byte-exact and reports where they diverge; when it carries only digests, equality of
 * the digests is the comparison — and a digest is never treated as a byte comparison.
 */
export const compareReplayOutputs = (
  recipe: SealedRecipe,
  replay: ReplayRunResult,
  mode: ReplayMode = 're-run'
): ReplayReport => {
  const files: FileVerdict[] = []
  const reasons: string[] = []
  const replayByPath = new Map(replay.outputs.map((output) => [output.path, output]))
  const versionMismatch = recipe.appVersion !== replay.appVersion

  for (const original of recipe.outputs) {
    const replayed = replayByPath.get(original.path)
    if (!replayed) {
      files.push({ path: original.path, status: 'missing' })
      reasons.push(`${original.path}: the replay produced no file at this path`)
      continue
    }
    replayByPath.delete(original.path)

    if (!original.sha256 || !replayed.sha256) {
      files.push({ path: original.path, status: 'not-comparable', reason: 'no-digest-recorded' })
      reasons.push(`${original.path}: no digest was recorded, so nothing could be checked`)
      continue
    }

    const size = Math.max(original.sizeBytes, replayed.sizeBytes)
    if (size > MAX_BYTE_COMPARISON_BYTES) {
      files.push({
        path: original.path,
        status: 'not-comparable',
        reason: 'size-beyond-comparison-bound'
      })
      reasons.push(
        `${original.path}: ${size} bytes exceeds the comparison bound (${MAX_BYTE_COMPARISON_BYTES})`
      )
      continue
    }
    if (versionMismatch) {
      files.push({ path: original.path, status: 'not-comparable', reason: 'app-version-mismatch' })
      reasons.push(
        `${original.path}: captured under ${recipe.appVersion}, replayed under ${replay.appVersion}`
      )
      continue
    }

    if (original.sha256 === replayed.sha256 && original.sizeBytes === replayed.sizeBytes) {
      files.push({ path: original.path, status: 'match' })
      continue
    }

    if (original.bytes !== undefined && replayed.bytes !== undefined) {
      files.push({
        path: original.path,
        status: 'differs',
        firstDifferingByte: firstDifferingByte(original.bytes, replayed.bytes),
        originalBytes: original.sizeBytes,
        replayBytes: replayed.sizeBytes
      })
      reasons.push(
        `${original.path}: the first differing byte is at offset ${firstDifferingByte(
          original.bytes,
          replayed.bytes
        )}`
      )
      continue
    }

    // Digests differ but the bytes were not captured: the difference is real and its location unknown.
    files.push({
      path: original.path,
      status: 'differs',
      firstDifferingByte: -1,
      originalBytes: original.sizeBytes,
      replayBytes: replayed.sizeBytes
    })
    // No bytes on one side means no offset to point at — so the digests themselves are the provenance:
    // a reader can compare them against whatever else holds the file.
    reasons.push(
      `${original.path}: recorded ${original.sha256.slice(0, 16)}…, found ${replayed.sha256.slice(
        0,
        16
      )}… (the byte offset was not captured)`
    )
  }

  for (const [path] of replayByPath) {
    files.push({ path, status: 'extra' })
    reasons.push(`${path}: the replay produced a file the recipe did not have`)
  }

  return { mode, verdict: verdictFor(recipe, files, mode), origin: recipe.origin, files, reasons }
}

const verdictFor = (
  recipe: SealedRecipe,
  files: readonly FileVerdict[],
  mode: ReplayMode
): ReplayVerdict => {
  // A reconstructed recipe describes what a model thinks ran. That can never be evidence of a re-run,
  // however well the outputs line up — reported as unverifiable even when every file matches. It says
  // nothing about record integrity, though: whether bytes still match a stored digest does not depend
  // on where the steps came from, so that mode is left to the file verdicts.
  if (mode === 're-run' && recipe.origin === 'reconstructed') return 'unverifiable'
  if (files.some((file) => file.status === 'not-comparable')) return 'unverifiable'
  const weakest = files.some((file) => file.status !== 'match')
  if (mode === 'record-integrity') return weakest ? 'changed' : 'intact'
  return weakest ? 'differs' : 'reproduced'
}

/** One line for a report or a ledger: never claims more than the file verdicts support. */
export const describeReplayVerdict = (report: ReplayReport): string => {
  if (report.verdict === 'reproduced') {
    return `Reproduced: all ${report.files.length} output(s) matched`
  }
  if (report.verdict === 'intact') {
    return `Record intact: all ${report.files.length} output(s) still match the recorded digests`
  }
  if (report.verdict === 'changed') {
    return `Changed since it was recorded: ${report.reasons.join('; ')}`
  }
  if (report.verdict === 'unverifiable') {
    return report.origin === 'reconstructed'
      ? 'Not verifiable: the steps came from a model reconstruction, not from an execution record'
      : `Not verifiable: ${report.reasons.join('; ')}`
  }
  return `Differs: ${report.reasons.join('; ')}`
}
