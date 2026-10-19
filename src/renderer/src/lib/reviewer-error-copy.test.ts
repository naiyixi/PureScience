import { describe, expect, it } from 'vitest'

import { classifyReviewError, reviewErrorCopyKey, reviewErrorShortKey } from './reviewer-error-copy'

// The five messages below are copied verbatim from the installed app's database (table Review,
// lifecycle='error', and the development instance's own row) — they are what the panel really received,
// not examples invented for the test.
const FIELD_MESSAGES = {
  provider:
    'Internal error: API Error: 402 Insufficient Balance (request_id: 629b6429-b421-4519-a481-e851d47ebe66)',
  protocol: 'Reviewer stopped without calling submit_findings.',
  runtime: 'ACP connection closed',
  persistence:
    'Invalid `tx.review.update()` invocation in\n' +
    '/Applications/PureScience.app/Contents/Resources/app.asar/out/main/ipc-CLnmvMls.js:2029:23\n' +
    '\n' +
    '  2026 for (const sourceReviewId of touchedSourceReviewIds) {\n' +
    '  2027   await touchReview(tx, sourceReviewId);\n' +
    '  2028 }\n' +
    '  → 2029 await tx.review.update(\n' +
    'Transaction API error: Transaction already closed: A query cannot be executed on an expired ' +
    'transaction. The timeout for this transaction was 5000 ms, however 6692 ms passed since the start ' +
    'of the transaction. Consider increasing the interactive transaction timeout or doing less work in ' +
    'the transaction.',
  timeout: 'reviewer session timed out before stopping'
} as const

describe('classifyReviewError', () => {
  it.each([
    ['persistence', FIELD_MESSAGES.persistence],
    ['protocol', FIELD_MESSAGES.protocol],
    ['provider', FIELD_MESSAGES.provider],
    ['runtime', FIELD_MESSAGES.runtime],
    ['timeout', FIELD_MESSAGES.timeout]
  ] as const)('classifies the field message as %s', (family, message) => {
    expect(classifyReviewError(message)).toBe(family)
  })

  // The persistence message quotes its own 5 s transaction budget. Reading it as a timeout would tell the
  // reader the review was too slow to finish, when in fact the verdict was produced and then lost.
  it('reads a transaction that expired mid-commit as persistence, not as a timeout', () => {
    expect(FIELD_MESSAGES.persistence).toContain('timeout')
    expect(classifyReviewError(FIELD_MESSAGES.persistence)).toBe('persistence')
  })

  it('keeps the snapshot-write failure apart from a verdict that never committed', () => {
    expect(classifyReviewError('Review scope snapshot storage is not configured.')).toBe('storage')
    expect(classifyReviewError('ENOSPC: no space left on device, open …')).toBe('storage')
  })

  it('recognises the permission-gated variant of the incomplete-protocol stop', () => {
    expect(
      classifyReviewError(
        'Reviewer stopped without calling submit_findings; 3 tool call(s) were also rejected by the ' +
          'permission gate.'
      )
    ).toBe('protocol')
  })

  // Guessing a cause is worse than admitting none: an unrecognised message must not borrow a family's
  // sentence (which would tell the reader something that was never established).
  it('reports an unrecognised message as unknown instead of guessing', () => {
    expect(classifyReviewError('Something else entirely went wrong.')).toBe('unknown')
    expect(classifyReviewError('')).toBe('unknown')
    expect(classifyReviewError(undefined)).toBe('unknown')
  })

  it('names a dictionary key for every family', () => {
    expect(reviewErrorCopyKey('persistence')).toBe('reviewer.error.persistence')
    expect(reviewErrorShortKey('timeout')).toBe('reviewer.errorShort.timeout')
  })
})
