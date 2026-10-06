import type {
  PersistedChatMessage,
  PersistedToolActivity,
  PersistedToolCallLocation
} from './session-persistence'

// IC52, stage 1: the read-only step sequence a session replay view walks. A step is what the session
// itself recorded — a user prompt, or one tool call the agent made while answering it. Nothing here
// invents a value: a field the session did not record stays absent, and an activity whose prompt can no
// longer be found is still listed (carrying no prompt id) rather than dropped, because "this step has no
// prompt to attach to" is a fact about the record, not a reason to hide it.
export type SessionReplayStepKind = 'prompt' | 'tool'

export type SessionReplayStep = {
  id: string
  kind: SessionReplayStepKind
  /** The transcript anchor this step scrolls to — always the message the step belongs to. */
  messageId: string
  /** Present on both kinds; absent when the recorded prompt message no longer exists in the transcript. */
  promptMessageId?: string
  title: string
  status?: PersistedToolActivity['status']
  /** The provider's own tool name when recorded, otherwise the activity's title/kind. Never synthesised. */
  toolName?: string
  toolKind?: string
  createdAt?: number
  /** Files this step touched, as the session recorded them (the "what did it write" angle). */
  locations?: readonly PersistedToolCallLocation[]
  /** The terminal exit code when this step ran something; absent when nothing was recorded. */
  terminalExitCode?: number | null
  /** A bounded excerpt of the terminal output, only when the session recorded any. */
  terminalOutput?: string
  /** Artifact versions this step's prompt links to (session-level file records are not duplicated here). */
  artifactIds: string[]
}

export type SessionReplaySource = {
  messages: readonly PersistedChatMessage[]
  activities?: readonly PersistedToolActivity[]
}

const isPrompt = (message: PersistedChatMessage): boolean => message.role === 'user'

/**
 * Orders a session into the steps a reader can walk: each user prompt, followed by the tool calls the
 * agent made while answering it, in the order the session recorded (`sortIndex`, then `createdAt`).
 */
export const buildSessionReplay = (source: SessionReplaySource): SessionReplayStep[] => {
  const prompts = source.messages.filter(isPrompt)
  const promptOrder = new Map(prompts.map((message, index) => [message.id, index]))
  const promptById = new Map(prompts.map((message) => [message.id, message]))

  const promptSteps: SessionReplayStep[] = prompts.map((message) => ({
    id: `prompt:${message.id}`,
    kind: 'prompt',
    messageId: message.id,
    promptMessageId: message.id,
    title: message.content,
    artifactIds: message.artifactIds ?? []
  }))

  const activities = source.activities ?? []
  const toolSteps: SessionReplayStep[] = activities.map((activity) => {
    const promptMessageId =
      activity.promptMessageId && promptById.has(activity.promptMessageId)
        ? activity.promptMessageId
        : undefined

    return {
      id: `tool:${activity.id}`,
      kind: 'tool',
      // A tool step anchors on its prompt when the transcript still has one; otherwise it anchors on
      // its own id, which is what the view has to scroll to.
      messageId: promptMessageId ?? activity.id,
      ...(promptMessageId ? { promptMessageId } : {}),
      title: activity.title,
      status: activity.status,
      ...(activity.providerToolName ? { toolName: activity.providerToolName } : {}),
      ...(activity.toolKind ? { toolKind: activity.toolKind } : {}),
      createdAt: activity.createdAt,
      // The angles a step can be inspected from, each present only when the session recorded it: the files
      // it touched, and what running it printed. A step that recorded none of these stays silent about them.
      ...(activity.toolLocations && activity.toolLocations.length > 0
        ? { locations: activity.toolLocations }
        : {}),
      ...(activity.terminalExitCode === undefined
        ? {}
        : { terminalExitCode: activity.terminalExitCode }),
      ...(activity.terminalOutput ? { terminalOutput: activity.terminalOutput } : {}),
      artifactIds: []
    }
  })

  const order = (activity: PersistedToolActivity): number => {
    const position = activity.promptMessageId
      ? promptOrder.get(activity.promptMessageId)
      : undefined
    return position ?? Number.MAX_SAFE_INTEGER
  }
  const bySortIndex = new Map(activities.map((activity) => [activity.id, activity.sortIndex]))

  const sortedTools = [...toolSteps].sort((left, right) => {
    const leftActivity = activities.find((activity) => `tool:${activity.id}` === left.id)
    const rightActivity = activities.find((activity) => `tool:${activity.id}` === right.id)
    if (!leftActivity || !rightActivity) return 0

    const byPrompt = order(leftActivity) - order(rightActivity)
    if (byPrompt !== 0) return byPrompt

    const byIndex =
      (bySortIndex.get(leftActivity.id) ?? 0) - (bySortIndex.get(rightActivity.id) ?? 0)
    if (byIndex !== 0) return byIndex

    return (leftActivity.createdAt ?? 0) - (rightActivity.createdAt ?? 0)
  })

  const steps: SessionReplayStep[] = []
  for (const prompt of promptSteps) {
    steps.push(prompt)
    for (const tool of sortedTools) {
      if (tool.promptMessageId === prompt.promptMessageId) steps.push(tool)
    }
  }

  // Steps that could not be attached to a prompt still belong to the record; they go last, in their
  // recorded order, so a reader sees them instead of a silently shorter list.
  for (const tool of sortedTools) {
    if (!tool.promptMessageId) steps.push(tool)
  }

  return steps
}
