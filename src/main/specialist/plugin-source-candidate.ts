import { randomUUID } from 'node:crypto'

import {
  checkPluginDeclaration,
  type PluginDeclarationCheck,
  type PluginSourceCandidatePreview
} from '../../shared/plugin-source'
import {
  previewPluginSource,
  type PluginFetchOutcome,
  type PluginSourcePreview
} from './plugin-source'

// E2: the step between a preview and a deployment. A window previews a repository, the app keeps what was
// previewed under an opaque token, and the later deploy step can only act on a token this module issued —
// bound to the digest of the bytes that were actually read. That is what makes "deploy what I approved"
// checkable instead of a second fetch of whatever the host returns later.
//
// Nothing here writes, installs or executes: it answers questions about a declaration.

export type PluginSourceCandidate = PluginSourceCandidatePreview<PluginSourcePreview> & {
  /** What the declaration was checked against, before anything could be deployed or run. */
  declaration: PluginDeclarationCheck
}

type CandidateRecord = {
  preview: PluginSourcePreview
  declaration: PluginDeclarationCheck
  ownerId: string
  createdAt: number
}

const DEFAULT_TTL_MS = 30 * 60 * 1000

export class PluginSourceCandidateStore {
  private readonly candidates = new Map<string, CandidateRecord>()

  constructor(
    private readonly deps: {
      fetchBytes: (url: string) => Promise<PluginFetchOutcome>
      now?: () => number
      ttlMs?: number
    }
  ) {}

  /**
   * Fetches and checks in one step, and keeps the result under a token. A preview that could not be read is
   * NOT stored: there is nothing to deploy, so issuing a token for it would only invite a later step to act
   * on a refusal.
   */
  async preview(reference: string, ownerId: string): Promise<PluginSourceCandidate> {
    const preview = await previewPluginSource(reference, { fetchBytes: this.deps.fetchBytes })
    const declaration: PluginDeclarationCheck =
      preview.state === 'available' ? checkPluginDeclaration(preview.manifest) : { state: 'ok' }
    const candidateToken = randomUUID()
    if (preview.state === 'available') {
      this.prune()
      this.candidates.set(candidateToken, {
        preview,
        declaration,
        ownerId,
        createdAt: this.now()
      })
    }
    return { ...preview, candidateToken, declaration }
  }

  /**
   * The record a later step needs, by token. A token is only honoured for the owner it was issued to, and it
   * expires: an approval given half an hour ago is not an approval of whatever the host serves now.
   */
  take(
    token: string,
    ownerId: string
  ):
    | { state: 'ok'; record: CandidateRecord }
    | { state: 'refused'; reason: 'unknown-token' | 'token-expired' } {
    // The record is read BEFORE anything is pruned: an expired approval is named as expired, which is a
    // different sentence from "this token was never issued" and tells the reader what to do about it.
    const record = this.candidates.get(token)
    if (!record || record.ownerId !== ownerId) return { state: 'refused', reason: 'unknown-token' }
    if (this.now() - record.createdAt > this.ttl()) {
      this.candidates.delete(token)
      return { state: 'refused', reason: 'token-expired' }
    }
    this.prune()
    return { state: 'ok', record }
  }

  /** Drops what an owner held, and reports how many records went: a silent drop is not a disposal. */
  dispose(ownerId: string): number {
    let dropped = 0
    for (const [token, record] of this.candidates) {
      if (record.ownerId === ownerId) {
        this.candidates.delete(token)
        dropped += 1
      }
    }
    return dropped
  }

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  private ttl(): number {
    return this.deps.ttlMs ?? DEFAULT_TTL_MS
  }

  private prune(): void {
    const cutoff = this.now() - this.ttl()
    for (const [token, record] of this.candidates) {
      if (record.createdAt <= cutoff) this.candidates.delete(token)
    }
  }
}
