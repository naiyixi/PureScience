import { describe, expect, it } from 'vitest'

import {
  BACKGROUND_RESULT_NEEDS_ATTENTION_SUMMARY,
  BACKGROUND_RESULT_NEEDS_ATTENTION_TITLE
} from '../../shared/notifications'
import { buildNeedsAttentionNotification } from './needs-attention-notification'

const delivery = (
  overrides: Partial<Parameters<typeof buildNeedsAttentionNotification>[0]> = {}
): Parameters<typeof buildNeedsAttentionNotification>[0] => ({
  id: 'delivery-1',
  sessionId: 'session-1',
  projectId: 'project-1',
  jobId: 'job-1',
  ...overrides
})

describe('the needs-attention inbox card', () => {
  it('keys the card on the ledger row, so one row can never become two cards', () => {
    expect(buildNeedsAttentionNotification(delivery()).dedupeKey).toBe(
      'task.needs-attention:session-1:delivery-1'
    )
    // A later pass builds the identical key: that is what makes a repeat a no-op in the inbox instead of
    // a second card, and it is why the reporter does not have to remember what it already reported.
    expect(buildNeedsAttentionNotification(delivery()).dedupeKey).toBe(
      buildNeedsAttentionNotification(delivery()).dedupeKey
    )
    // A second blocked result in the same session is a distinct card.
    expect(buildNeedsAttentionNotification(delivery({ id: 'delivery-2' })).dedupeKey).toBe(
      'task.needs-attention:session-1:delivery-2'
    )
    // So is the same row id belonging to a different session.
    expect(buildNeedsAttentionNotification(delivery({ sessionId: 'session-2' })).dedupeKey).toBe(
      'task.needs-attention:session-2:delivery-1'
    )
  })

  it('carries the canonical wording and the origin the renderer needs to open the conversation', () => {
    const card = buildNeedsAttentionNotification(delivery())
    expect(card.kind).toBe('task.needs-attention')
    expect(card.source).toBe('compute')
    // The wording is recorded in one language and mapped by the renderer, so both sides have to agree on
    // the exact string: the constants are the single source for it.
    expect(card.title).toBe(BACKGROUND_RESULT_NEEDS_ATTENTION_TITLE)
    expect(card.summary).toBe(BACKGROUND_RESULT_NEEDS_ATTENTION_SUMMARY)
    expect(card.projectId).toBe('project-1')
    expect(card.sessionId).toBe('session-1')
    expect(card.originId).toBe('job-1')
  })
})
