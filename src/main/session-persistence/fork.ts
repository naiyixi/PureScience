// Session forking over storage ports: the main process's entry to the shared fork logic.
//
// Measurement and construction live in `src/shared/session-fork.ts`, so the renderer — which already
// builds and saves session documents through the persistence channels — produces the same copy from
// the same rules instead of a second implementation. This file owns only what needs I/O: reading the
// source, asking for its size, and writing the copy. The source document is read, never written.

import { planSessionFork, buildSessionFork } from '../../shared/session-fork'
import type { SessionForkManifest } from '../../shared/session-fork'
import type { PersistedChatSession } from '../../shared/session-persistence'

export type { SessionForkBuildOptions, SessionForkManifest } from '../../shared/session-fork'

export type SessionForkPorts = {
  load: (projectId: string, sessionId: string) => Promise<PersistedChatSession | undefined>
  save: (session: PersistedChatSession) => Promise<void>
  // Optional: the document's size on disk, when the caller can measure it.
  sizeBytes?: (projectId: string, sessionId: string) => Promise<number | undefined>
  newId: () => string
  now: () => number
}

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
    return planSessionFork(source, bytes)
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
    const built = buildSessionFork(source, {
      newId: this.ports.newId,
      now: this.ports.now,
      ...(options.sourceMessageId ? { sourceMessageId: options.sourceMessageId } : {})
    })
    await this.ports.save(built.session)
    // The manifest describes the whole source, even when the copy was cut at a turn: the caller has to
    // know what was left behind as well as what was kept.
    const bytes = this.ports.sizeBytes
      ? await this.ports.sizeBytes(projectId, sessionId)
      : undefined
    return { session: built.session, manifest: planSessionFork(source, bytes) }
  }
}
