// What a session package cost, derived from the transcript it carries — never from a claim.
//
// A package is input from another machine, so the manifest's numbers are the SENDER's assertion. The
// only way a receiver can tell a true summary from a flattering one is to compute it again from the
// bytes that actually travelled. This module is that one implementation: the exporter uses it to write
// the summary, the importer uses it to check the summary, and a third party can use it to audit a
// package without any of our code.
//
// Three rules keep the numbers honest:
//   · absence is named, never zeroed — an agent message that carries neither a usage record nor an
//     explicit "unavailable" marker counts as `turnsWithoutUsage`, so a reader can tell a cheap turn
//     from a turn whose cost was never recorded (a floor is not a total);
//   · a shape we do not recognise yields `null`, and a `null` derivation never compares equal to any
//     declared summary — an underivable transcript and a matching one must not look the same;
//   · the comparison is field by field, and it reports WHICH fields differ, because "the package's
//     numbers do not match its own transcript" is useless without the field.
export type SessionPackageUsage = {
  /** User prompts in the carried transcript. */
  turns: number
  /** Durable tool activity rows the transcript carries. */
  toolCalls: number
  /** Sum of the per-turn input token records, over turns that recorded it. */
  inputTokens: number
  /** Sum of the per-turn output token records, over turns that recorded it. */
  outputTokens: number
  /** Agent messages that carry neither a usage record nor an `unavailable` marker. */
  turnsWithoutUsage: number
}

export type SessionPackageUsageComparison =
  | { state: 'match' }
  | { state: 'mismatch'; fields: readonly (keyof SessionPackageUsage)[] }
  // The manifest carries no summary at all (older exporter). Not a failure, and never read as a match.
  | { state: 'not-recorded' }
  // The conversation's shape is not one this derivation understands.
  | { state: 'underivable' }

const USAGE_FIELDS: readonly (keyof SessionPackageUsage)[] = [
  'turns',
  'toolCalls',
  'inputTokens',
  'outputTokens',
  'turnsWithoutUsage'
]

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const tokenCount = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined

/**
 * Recomputes the summary from a parsed `conversation.json`.
 *
 * Returns `null` when the document is not shaped like a transcript: the caller must then treat the
 * summary as absent rather than as zero, and no comparison may succeed against it.
 */
export const deriveSessionPackageUsage = (conversation: unknown): SessionPackageUsage | null => {
  if (!isRecord(conversation)) return null
  const messages = conversation.messages
  if (!Array.isArray(messages)) return null

  let turns = 0
  let inputTokens = 0
  let outputTokens = 0
  let turnsWithoutUsage = 0

  for (const message of messages) {
    if (!isRecord(message)) return null
    if (message.role === 'user') {
      turns += 1
      continue
    }
    if (message.role !== 'agent') continue

    const usage = message.turnUsage
    if (isRecord(usage)) {
      const input = tokenCount(usage.inputTokens)
      const output = tokenCount(usage.outputTokens)
      // A usage record whose counters are not readable counts as unrecorded — a half-parsed record must
      // not contribute a partial sum that later looks like a total.
      if (input === undefined || output === undefined) {
        turnsWithoutUsage += 1
        continue
      }
      inputTokens += input
      outputTokens += output
      continue
    }
    // `turnUsageUnavailable` is the product's explicit "this turn's cost was not recorded" marker; it is
    // named here rather than folded into `turnsWithoutUsage`, which is the weaker "nothing was written".
    if (message.turnUsageUnavailable !== true) turnsWithoutUsage += 1
  }

  const activities = conversation.activities
  if (activities !== undefined && !Array.isArray(activities)) return null
  const toolCalls = Array.isArray(activities) ? activities.length : 0

  return { turns, toolCalls, inputTokens, outputTokens, turnsWithoutUsage }
}

const isDeclaredUsage = (value: unknown): value is SessionPackageUsage => {
  if (!isRecord(value)) return false
  return USAGE_FIELDS.every((field) => tokenCount(value[field]) !== undefined)
}

/**
 * Compares a manifest's declared summary with the summary derived from the transcript.
 *
 * A mismatch names the fields that differ. `not-recorded` (no summary in the manifest) and
 * `underivable` (a transcript this module cannot read) are distinct states, and neither may be read
 * as agreement.
 */
export const compareSessionPackageUsage = (
  declared: unknown,
  derived: SessionPackageUsage | null
): SessionPackageUsageComparison => {
  if (declared === undefined || declared === null) return { state: 'not-recorded' }
  if (derived === null) return { state: 'underivable' }
  if (!isDeclaredUsage(declared)) return { state: 'underivable' }

  const fields = USAGE_FIELDS.filter((field) => declared[field] !== derived[field])
  return fields.length === 0 ? { state: 'match' } : { state: 'mismatch', fields }
}
