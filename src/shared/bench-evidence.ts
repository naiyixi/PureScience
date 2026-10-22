// Turning a recorded session into the evidence a benchmark case is graded against.
//
// What this deliberately does NOT do: extract quantities or citations from prose. A regex over a
// transcript can find a number, but it cannot tell whether that number carried provenance — and a
// grader that believed a regex would manufacture the very evidence it is supposed to check. Those
// two fields stay absent, and `collected` says so, so a check that needs them fails for the honest
// reason ("nothing was recorded") rather than passing on a guess.

import type { BenchEvidence } from './sci-bench-v1'
import type { PersistedArtifact, PersistedChatSession } from './session-persistence'

export type SessionEvidence = BenchEvidence & {
  /** Which evidence classes were actually gathered. Absent ones are named, not zero-filled. */
  collected: {
    transcript: boolean
    toolCalls: boolean
    artifacts: boolean
    numbers: false
    citations: false
  }
}

const isAgentRole = (role: string): boolean => role === 'agent' || role === 'assistant'

export const benchEvidenceFromSession = (
  session: Pick<PersistedChatSession, 'messages' | 'activities'>,
  artifacts: readonly Pick<PersistedArtifact, 'path' | 'name'>[]
): SessionEvidence => {
  const messages = session.messages ?? []
  const transcriptParts: string[] = []
  const turns: string[] = []
  for (const message of messages) {
    const text = (message.content ?? '').trim()
    if (!text) continue
    transcriptParts.push(text)
    if (isAgentRole(message.role)) turns.push(text)
  }

  const toolCalls = (session.activities ?? []).flatMap((activity) => {
    const name = activity.providerToolName ?? activity.toolKind ?? activity.title
    if (!name) return []
    const args =
      activity.rawInput &&
      typeof activity.rawInput === 'object' &&
      !Array.isArray(activity.rawInput)
        ? (activity.rawInput as Record<string, unknown>)
        : undefined
    return [{ name, ...(args ? { args } : {}) }]
  })

  // The stored `path` is a content blob (…/versions/<id>/content), not the name the session used;
  // grading on that would make every filename-shaped check fail for a reason nobody can see.
  // Prefer the original name and keep the blob path only as a fallback.
  const artifactPaths = artifacts
    .map((artifact) => ('name' in artifact && artifact.name ? artifact.name : artifact.path))
    .filter(Boolean)

  return {
    transcript: transcriptParts.join('\n'),
    turns,
    ...(toolCalls.length ? { toolCalls } : {}),
    ...(artifactPaths.length ? { artifacts: artifactPaths } : {}),
    collected: {
      transcript: transcriptParts.length > 0,
      toolCalls: toolCalls.length > 0,
      artifacts: artifactPaths.length > 0,
      numbers: false,
      citations: false
    }
  }
}
