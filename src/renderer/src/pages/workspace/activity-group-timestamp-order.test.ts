import { describe, expect, it } from 'vitest'

import type { ChatMessage, ChatSession, ToolActivity } from '@/stores/session-store'

import { createConversationItems } from './workspace-conversation-items'
import { groupConversationItems } from './workspace-tool-activity-groups'

// Why this exists: the E1/E2 true-machine reading could not get a "settled group / newest group" pair —
// a real window with two turns of tool activity produced ONE group. The drafts blamed the fixture and
// stopped there. This pins down the actual rule the transcript obeys, so the fixture can be fixed against
// it instead of against a guess: activity items are ordered by their own `createdAt` (falling back to
// array position), so activities that all carry the SAME timestamp land after every message and merge
// into a single group no matter how many turns produced them.
const message = (overrides: Partial<ChatMessage>): ChatMessage => ({
  id: 'message-1',
  role: 'user',
  content: 'Prompt',
  status: 'complete',
  eventIds: [],
  createdAt: 1_000,
  updatedAt: 1_000,
  ...overrides
})

const activity = (overrides: Partial<ToolActivity>): ToolActivity => ({
  id: 'tool-1',
  kind: 'tool',
  title: 'Read file',
  status: 'completed',
  eventIds: [],
  sortIndex: 0,
  createdAt: 1_000,
  updatedAt: 1_000,
  ...overrides
})

const session = (activities: ToolActivity[]): ChatSession => ({
  id: 'session-1',
  projectId: 'project-1',
  title: 'Session',
  cwd: '/workspace',
  status: 'idle',
  messages: [
    message({ id: 'prompt-1', createdAt: 1_000 }),
    message({ id: 'reply-1', role: 'agent', content: 'one', createdAt: 1_100 }),
    message({ id: 'prompt-2', createdAt: 2_000 }),
    message({ id: 'reply-2', role: 'agent', content: 'two', createdAt: 2_100 })
  ],
  activities,
  createdAt: 1_000,
  updatedAt: 2_100
})

const groupsOf = (activities: ToolActivity[]): number =>
  groupConversationItems(createConversationItems(session(activities))).filter(
    (item) => item.type === 'activity-group'
  ).length

describe('activity grouping depends on the activities’ own timestamps', () => {
  it('gives each turn its own group when the activities carry per-turn timestamps', () => {
    const groups = groupsOf([
      activity({ id: 'old-1', createdAt: 1_050 }),
      activity({ id: 'new-1', createdAt: 2_050 })
    ])

    expect(groups).toBe(2)
  })

  it('merges every turn into one group when the activities share one timestamp', () => {
    // This is what the fixture agent produced: all lifecycles stamped at the same instant, so they sort
    // after every message and become one adjacent run.
    const groups = groupsOf([
      activity({ id: 'old-1', createdAt: 9_000 }),
      activity({ id: 'new-1', createdAt: 9_000 })
    ])

    expect(groups).toBe(1)
  })
})
