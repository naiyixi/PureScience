// Which of the five contract failure classes does a real error message belong to?
//
// This exists because the app has two vocabularies: contracts name five failure classes, and everything
// else reports messages. Without a classifier, "30 real failures replayed, five-class coverage ≥90%" is
// unanswerable, and a missing precondition keeps arriving as an unnamed traceback.
//
// Rules:
//   • Ordered matchers, first match wins — the order encodes what a message MEANS, not what it mentions
//     (an ENOENT inside a "timed out waiting for file" sentence is a missing file, not a timeout).
//   • No match returns null. `null` is the honest answer for a message this module cannot place, and the
//     replay counts it as uncovered instead of forcing it into `failed_execution`.

import type { CapabilityFailureClass } from './capability-contract'

type Matcher = { failureClass: CapabilityFailureClass; pattern: RegExp }

const MATCHERS: readonly Matcher[] = [
  // An object exists but cannot be used as declared.
  {
    failureClass: 'incompatible_object',
    pattern:
      /(corrupt|checksum|malformed|invalid (json|manifest|registry)|(manifest|registry)[^.]{0,24}invalid|is invalid|unexpected shape|unsupported version|unreadable|does not parse)/iu
  },
  // The call did not match the declared interface. Kept ahead of the "not found" rules on purpose:
  // "Cannot read properties of undefined" is a shape mistake, not a missing file.
  {
    failureClass: 'invalid_arguments',
    pattern:
      /(cannot read propert|is required|must be (between|a|an|at least|one of)|invalid (argument|url|value|input)|expected .{0,20}(got|but)|schema|validation|EINVAL|no handler registered)/iu
  },
  // A declared precondition is absent: a file/record that should exist does not.
  {
    failureClass: 'missing_state',
    pattern:
      /(ENOENT|no such file|does not exist|is missing|not found: |missing (file|input|record)|file not found)/iu
  },
  // Something the step depends on could not serve: a service, a binary, a port, a quota.
  {
    failureClass: 'unavailable_dependency',
    pattern:
      /(ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNABORTED|rate limit|insufficient balance|\b(429|500|502|503|504)\b|not installed|executable not found|is not installed|not available|in use by a running)/iu
  },
  // The step ran and failed on its own terms.
  {
    failureClass: 'failed_execution',
    pattern:
      /(exit code [1-9]|traceback|threw|assertionerror|aggregateerror|referenceerror|typeerror|failed|timed out|timeout|transaction)/iu
  }
]

export const classifyCapabilityFailure = (message: string): CapabilityFailureClass | null => {
  const text = message.trim()
  if (!text) return null
  for (const matcher of MATCHERS) {
    if (matcher.pattern.test(text)) return matcher.failureClass
  }
  return null
}
