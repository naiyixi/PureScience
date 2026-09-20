// Session forking (v1.65 unit 3): copy a session into a new, writable session that carries the same
// research history, while the source document is never touched.
//
// Two rules shape this file, and both come from what a reader needs afterwards rather than from what
// is convenient to copy:
//
//   1. Measure before copying. `planFork` reports what the copy will contain (messages, agent replies,
//      uploads, artifact references) and what it will not carry, so the decision is made on numbers
//      instead of on a spinner.
//   2. Inherit the evidence chain; never inherit identity. Messages get fresh ids (the fork's own
//      transcript), `responseToMessageId` is remapped onto those new ids, and artifact references keep
//      pointing at the versions the source produced — with `forkedFrom` recorded on the copy so the
//      lineage back to the source survives. The source is read, and only read.

import type { PersistedChatMessage, PersistedChatSession } from '../../shared/session-persistence'

export type SessionForkPorts = {
  load: (projectId: string, sessionId: string) => Promise<PersistedChatSession | undefined>
  save: (session: PersistedChatSession) => Promise<void>
  // Optional: the document's size on disk, when the caller can measure it.
  sizeBytes?: (projectId: string, sessionId: string) => Promise<number | undefined>
  newId: () => string
  now: () => number
}

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
  notCarried: string[]
}

const countUploads = (messages: readonly PersistedChatMessage[]): number =>
  messages.reduce((total, message) => total + (message.uploads?.length ?? 0), 0)

const countArtifactReferences = (messages: readonly PersistedChatMessage[]): number => {
  const ids = new Set<string>()
  for (const message of messages) {
    for (const id of message.artifactIds ?? []) ids.add(id)
  }
  return ids.size
}

const buildManifest = (
  source: PersistedChatSession,
  bytes: number | undefined
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
    // The fork's transcript is its own: message→activity links from the source would point at
    // activity rows that belong to the source's runs.
    'event-ids',
    // A fork starts idle; the source's run state (including "interrupted") is not inherited.
    'run-state',
    // Artifact versions are referenced, not duplicated: the copy reads the same immutable versions.
    'artifact-versions'
  ]
})

export class SessionForkError extends Error {
  readonly code: 'source-missing'

  constructor(code: SessionForkError['code'], message: string) {
    super(message)
    this.name = 'SessionForkError'
    this.code = code
  }
}

export class SessionForkService {
  constructor(private readonly ports: SessionForkPorts) {}

  // The measurement half: what a copy would contain. Returns undefined when the source is gone, which
  // the caller reports as such instead of offering a copy of nothing.
  async planFork(projectId: string, sessionId: string): Promise<SessionForkManifest | undefined> {
    const source = await this.ports.load(projectId, sessionId)
    if (!source) return undefined
    const bytes = this.ports.sizeBytes
      ? await this.ports.sizeBytes(projectId, sessionId)
      : undefined
    return buildManifest(source, bytes)
  }

  // The copy half. Fresh message ids, remapped reply links, the same artifact references, and
  // provenance written on the copy only.
  async forkSession(
    projectId: string,
    sessionId: string,
    options: { sourceMessageId?: string } = {}
  ): Promise<{ session: PersistedChatSession; manifest: SessionForkManifest }> {
    const source = await this.ports.load(projectId, sessionId)
    if (!source) {
      throw new SessionForkError('source-missing', `Session ${sessionId} does not exist.`)
    }
    const bytes = this.ports.sizeBytes
      ? await this.ports.sizeBytes(projectId, sessionId)
      : undefined
    const manifest = buildManifest(source, bytes)

    // The cut point: a fork taken at a turn keeps the history up to and including that turn.
    const cutIndex = options.sourceMessageId
      ? source.messages.findIndex((message) => message.id === options.sourceMessageId)
      : source.messages.length - 1
    const kept = cutIndex >= 0 ? source.messages.slice(0, cutIndex + 1) : [...source.messages]

    const idBySourceId = new Map<string, string>()
    for (const message of kept) idBySourceId.set(message.id, this.ports.newId())

    const timestamp = this.ports.now()
    const messages: PersistedChatMessage[] = kept.map((message) => {
      const remappedResponseTo = message.responseToMessageId
        ? idBySourceId.get(message.responseToMessageId)
        : undefined
      return {
        ...message,
        id: idBySourceId.get(message.id) as string,
        // Activity links belong to the source's runs; the copy starts its own log.
        eventIds: [],
        ...(remappedResponseTo === undefined
          ? { responseToMessageId: undefined }
          : { responseToMessageId: remappedResponseTo })
      }
    })

    const forked: PersistedChatSession = {
      ...source,
      id: this.ports.newId(),
      // A copy has not run yet, whatever the source was doing.
      status: 'idle',
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
    }
    // Any active run pointer belongs to the source's execution, not to a document that has not run.
    const { activeRun: _activeRun, ...withoutActiveRun } = forked as PersistedChatSession & {
      activeRun?: unknown
    }
    void _activeRun

    await this.ports.save(withoutActiveRun)
    return { session: withoutActiveRun, manifest }
  }
}
