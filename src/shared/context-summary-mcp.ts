// Shared identity + prompt contract for the agent-facing context-summary MCP server. This is the
// "searchable long context" capability: when the app compacts a session's context, the folded-away
// transcript is NOT discarded — it is persisted as an immutable summary chunk. The agent can later
// call summary_query to retrieve exact details from a chunk (a filename, a number, a decision)
// that the rolling summary elided, and boundary to mark task boundaries so future folds land
// between tasks instead of mid-task.

export const CONTEXT_SUMMARY_MCP_SERVER_NAME = 'purescience-context-summary'

export const SUMMARY_QUERY_TOOL_NAME = 'summary_query'
export const BOUNDARY_TOOL_NAME = 'boundary'

export const SUMMARY_QUERY_TOOL_DESCRIPTION =
  'Queries the exact content of a folded-away context chunk. When earlier conversation was ' +
  'compacted into a <summary id=…> block, use this to retrieve details the summary elided — an ' +
  'exact error message, a file path, a number, which option was chosen. Answers against the ' +
  'original chunk text, not the paraphrase.'

export const BOUNDARY_TOOL_DESCRIPTION =
  'Marks a task boundary in the session. Call it when you finish a distinct piece of work, so ' +
  'future context compaction folds land between tasks rather than mid-task. The label is a note ' +
  'to your future self about what just closed.'

// Rendered into the session prompt when the context-summary MCP is available: tells the agent
// when to query a folded chunk and when to mark a boundary.
export const CONTEXT_SUMMARY_MCP_SYSTEM_PROMPT_APPEND = [
  '<purescience_context_summary_instructions>',
  'Earlier conversation may be folded into <summary id=…> blocks to keep the context window ' +
    'manageable. The summary preserves the arc but drops verbatim detail.',
  'When you need something the summary elided — an exact error message, a file path, a command ' +
    'output, a number — call summary_query(summary_id=…, question=…). It answers against the ' +
    'original chunk.',
  'Call boundary(label=…) when you finish a distinct piece of work, so future folds land between ' +
    'tasks rather than mid-task. The label is a note to your future self about what just closed.',
  "If you are working from a summary's paraphrase and aren't confident a detail is exact — a " +
    'filename, a number, which option was chosen — verify with summary_query before acting on it.',
  '</purescience_context_summary_instructions>'
].join('\n')

// Persisted shape of one folded-away chunk. Stored per session (JSON file next to the session);
// immutable once written so a later transcript edit cannot rewrite audit evidence.
export type ContextSummaryChunk = {
  // Stable chunk identity; referenced by <summary id=…> and summary_query.
  id: string
  // Fold level: 1 = first (light) fold of a window; 2 = deeper re-fold of a previously folded
  // region (only its own summary text is retained, the original messages are superseded).
  level: 1 | 2
  // When the fold happened (epoch ms).
  foldedAt: number
  // Compaction reason that produced this chunk: automatic | manual | overflow-recovery.
  reason: string
  // Agent-supplied boundary label, when a boundary() call preceded this fold.
  boundaryLabel?: string
  // Token estimate of the folded window at fold time (usage tracker's estimate, best-effort).
  foldedTokens?: number
  // The message range folded: [firstMessageId, lastMessageId] of the original transcript.
  firstMessageId?: string
  lastMessageId?: string
  // The FULL original transcript of the folded window (messages + activity summaries), so
  // summary_query can answer verbatim. Level-2 chunks carry only the level-1 summary text.
  transcript: string
  // The rolling summary text that replaced this window in the live context.
  summaryText: string
  // The summary block id used in the live context (<summary id=…>).
  summaryId: string
}
