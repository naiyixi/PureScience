// Session forking, the pure half: measurement and construction with no I/O, so the main process and
// the renderer build a fork the same way instead of each inventing one.
//
// Two rules, both about what a reader needs afterwards:
//   1. Measure before copying — a fork reports what it will contain and what it will not carry.
//   2. Inherit the evidence chain, never the identity — messages get fresh ids, reply links are
//      remapped onto them, artifact references keep pointing at the same immutable versions, and
//      provenance is written on the copy (never on the source, which is not written at all).

import type { PersistedChatMessage, PersistedChatSession } from './session-persistence'

export type SessionForkManifest = {
  source: {
    projectId: string
    sessionId: string
    title: string
    updatedAt: number
    status: PersistedChatSession['status']
  }
  counts: {
    messages: number
    agentReplies: number
    uploads: number
    artifactReferences: number
  }
  bytes?: number
  // Named, never silent: what the copy does not carry, and why.
  notCarried: readonly string[]
}

// The three things a copy deliberately leaves behind.
export const SESSION_FORK_NOT_CARRIED = [
  // The fork's transcript is its own: message→activity links from the source would point at activity
  // rows that belong to the source's runs.
  'event-ids',
  // A fork starts idle; the source's run state (including "interrupted") is not inherited.
  'run-state',
  // Artifact versions are referenced, not duplicated: the copy reads the same immutable versions.
  'artifact-versions'
] as const

// An imported (`.science`) session is read-only by posture: its history is someone else's record. A
// fork of one is a new, writable session, so it must not claim that posture for itself — otherwise the
// copy would look like imported history and be treated as uneditable.
const IMPORT_POSTURE_KEYS = ['importedFrom', 'importRecord', 'importPosture', 'readOnly'] as const

const importPostureOn = (source: PersistedChatSession): string[] =>
  IMPORT_POSTURE_KEYS.filter(
    (key) => (source as unknown as Record<string, unknown>)[key] !== undefined
  )

const countUploads = (messages: readonly PersistedChatMessage[]): number =>
  messages.reduce((total, message) => total + (message.uploads?.length ?? 0), 0)

const countArtifactReferences = (messages: readonly PersistedChatMessage[]): number => {
  const ids = new Set<string>()
  for (const message of messages) {
    for (const id of message.artifactIds ?? []) ids.add(id)
  }
  return ids.size
}

export const planSessionFork = (
  source: PersistedChatSession,
  bytes?: number
): SessionForkManifest => ({
  source: {
    projectId: source.projectId,
    sessionId: source.id,
    title: source.title,
    updatedAt: source.updatedAt,
    status: source.status
  },
  counts: {
    messages: source.messages.length,
    agentReplies: source.messages.filter((message) => message.role === 'agent').length,
    uploads: countUploads(source.messages),
    artifactReferences: countArtifactReferences(source.messages)
  },
  ...(bytes === undefined ? {} : { bytes }),
  notCarried: [
    ...SESSION_FORK_NOT_CARRIED,
    // Named only when the source actually carries an import posture.
    ...(importPostureOn(source).length > 0 ? (['import-posture'] as const) : [])
  ]
})

export type SessionForkBuildOptions = {
  newId: () => string
  now: () => number
  // Cut point: keep history up to and including this message, when the caller wants a fork at a turn
  // rather than a copy of everything.
  sourceMessageId?: string
}

export const buildSessionFork = (
  source: PersistedChatSession,
  options: SessionForkBuildOptions
): { session: PersistedChatSession; manifest: SessionForkManifest } => {
  const manifest = planSessionFork(source)
  const cutIndex = options.sourceMessageId
    ? source.messages.findIndex((message) => message.id === options.sourceMessageId)
    : source.messages.length - 1
  const kept = cutIndex >= 0 ? source.messages.slice(0, cutIndex + 1) : [...source.messages]

  // The copy's own identity is minted first: a reader should be able to point at the new session id
  // before any of its messages, and the order of allocation is visible to callers that inject `newId`.
  const sessionId = options.newId()
  const idBySourceId = new Map<string, string>()
  for (const message of kept) idBySourceId.set(message.id, options.newId())

  const timestamp = options.now()
  const messages: PersistedChatMessage[] = kept.map((message) => {
    const remappedResponseTo = message.responseToMessageId
      ? idBySourceId.get(message.responseToMessageId)
      : undefined
    return {
      ...message,
      id: idBySourceId.get(message.id) as string,
      eventIds: [],
      ...(remappedResponseTo === undefined
        ? { responseToMessageId: undefined }
        : { responseToMessageId: remappedResponseTo })
    }
  })

  const forked = {
    ...source,
    id: sessionId,
    // A copy has not run yet, whatever the source was doing.
    status: 'idle' as PersistedChatSession['status'],
    messages,
    activities: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    forkedFrom: {
      sessionId: source.id,
      projectId: source.projectId,
      at: timestamp,
      ...(options.sourceMessageId ? { sourceMessageId: options.sourceMessageId } : {})
    }
  } as PersistedChatSession & { activeRun?: unknown }
  // Any active-run pointer belongs to the source's execution, not to a document that has not run.
  const { activeRun: _activeRun, ...withoutActiveRun } = forked
  void _activeRun

  // The copy is writable by construction: an import posture on the source (read-only history landed
  // from a `.science` package) is dropped, and `forkedFrom` is what records where the copy came from.
  const stripped = { ...(withoutActiveRun as Record<string, unknown>) }
  for (const key of importPostureOn(source)) delete stripped[key]

  return { session: stripped as PersistedChatSession, manifest }
}
