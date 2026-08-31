// Context-summary chunk capture: called after a context compaction completes. Loads the session's
// persisted transcript, folds the window that was compacted away into an immutable chunk (searchable
// via summary_query), and attaches the latest boundary label if the agent marked one.

import type { ContextSummaryRepository } from './context-summary-repository'

export type ContextSummaryCaptureOptions = {
  repository: ContextSummaryRepository
  // Resolves the persisted session for a compaction event. Returns undefined when the session is
  // not yet durable (async persistence queue) — the capture is skipped, not retried.
  loadSession: (projectId: string, sessionId: string) => Promise<unknown>
  // Resolves projectId for a sessionId (app sessions are owned by a project).
  projectIdForSession: (sessionId: string) => Promise<string | undefined> | string | undefined
}

// The window folded by one compaction: the message range BEFORE this compaction. Since native
// compaction happens inside the agent (the app only drives /compact), we approximate the folded
// window as the transcript as it existed at compaction time. The chunk's transcript is the session's
// message log flattened to text — the same content the agent summarized.
const flattenSessionTranscript = (session: unknown): string => {
  const messages = (session as { messages?: unknown[] })?.messages
  if (!Array.isArray(messages)) return ''
  const lines: string[] = []
  for (const message of messages) {
    const role = (message as { role?: string })?.role ?? 'message'
    const content = (message as { content?: unknown })?.content
    let text = ''
    if (typeof content === 'string') text = content
    else if (Array.isArray(content)) {
      text = content
        .map((block) => {
          const candidate = block as { type?: string; text?: string; name?: string }
          if (candidate.type === 'text' && typeof candidate.text === 'string') return candidate.text
          if (candidate.type === 'tool_use' && typeof candidate.name === 'string') {
            return `[tool_use:${candidate.name}]`
          }
          if (candidate.type === 'tool_result' && typeof candidate.text === 'string') {
            return `[tool_result] ${candidate.text}`
          }
          return ''
        })
        .filter(Boolean)
        .join('\n')
    }
    if (text.trim()) lines.push(`[${role}] ${text.trim()}`)
  }
  return lines.join('\n')
}

const createSummaryText = (input: {
  sessionId: string
  reason: string
  boundaryLabel?: string
  foldedAt: number
}): string =>
  `Context was compacted (${input.reason}) at ${new Date(input.foldedAt).toISOString()}. ` +
  (input.boundaryLabel ? `Boundary: ${input.boundaryLabel}. ` : '') +
  'Use summary_query on this chunk to retrieve verbatim details the summary elided.'

export const createContextSummaryCapture = (
  options: ContextSummaryCaptureOptions
): ((input: { sessionId: string; reason: string }) => Promise<void>) => {
  return async ({ sessionId, reason }) => {
    const projectId = await options.projectIdForSession(sessionId)
    if (!projectId) return
    let session: unknown
    try {
      session = await options.loadSession(projectId, sessionId)
    } catch {
      return // Not durable yet; the fold is best-effort.
    }
    if (!session) return

    const transcript = flattenSessionTranscript(session)
    if (!transcript.trim()) return

    const boundaryLabel = await options.repository.latestBoundaryLabel(sessionId)
    const foldedAt = Date.now()
    await options.repository.appendChunk({
      sessionId,
      level: 1,
      reason,
      boundaryLabel,
      transcript,
      summaryText: createSummaryText({ sessionId, reason, boundaryLabel, foldedAt })
    })
  }
}
