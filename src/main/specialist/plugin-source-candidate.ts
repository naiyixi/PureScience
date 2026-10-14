import { randomUUID } from 'node:crypto'

import {
  checkPluginDeclaration,
  type PluginDeclarationCheck,
  type PluginOperationOutcomeView,
  type PluginSourceCandidatePreview
} from '../../shared/plugin-source'
import {
  previewPluginSource,
  type PluginFetchOutcome,
  type PluginSourcePreview
} from './plugin-source'
import type { decidePluginOperation } from './plugin-run-policy'
import { deployCandidate, runCandidateOnce, type PluginOperationOutcome } from './plugin-operations'

// E2: the step between a preview and a deployment. A window previews a repository, the app keeps what was
// previewed under an opaque token, and the later deploy step can only act on a token this module issued —
// bound to the digest of the bytes that were actually read. That is what makes "deploy what I approved"
// checkable instead of a second fetch of whatever the host returns later.
//
// Nothing here writes, installs or executes: it answers questions about a declaration.

// A renderer window is identified by the sender id Electron reports, and that id is a number, or
// undefined for a sender that reports none. The store keeps the value as it came rather than
// inventing one: two windows never share a token.
export type PluginSourceOwnerId = string | number | undefined

export type PluginSourceCandidate = PluginSourceCandidatePreview<PluginSourcePreview> & {
  /** What the declaration was checked against, before anything could be deployed or run. */
  declaration: PluginDeclarationCheck
}

type CandidateRecord = {
  preview: PluginSourcePreview
  declaration: PluginDeclarationCheck
  ownerId: PluginSourceOwnerId
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
  async preview(reference: string, ownerId: PluginSourceOwnerId): Promise<PluginSourceCandidate> {
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
    ownerId: PluginSourceOwnerId
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
  dispose(ownerId: PluginSourceOwnerId): number {
    let dropped = 0
    for (const [token, record] of this.candidates) {
      if (record.ownerId === ownerId) {
        this.candidates.delete(token)
        dropped += 1
      }
    }
    return dropped
  }

  /**
   * E3-2: deploy and run are the store's own operations because the token and the bytes are the store's own
   * state. Both go through the gate first (see plugin-run-policy) — and what goes back to the window is codes
   * and parameters, never prose and never a decision the main process made on the reader's behalf.
   */
  async deploy(
    ownerId: PluginSourceOwnerId,
    token: string,
    options: {
      pluginsRoot: string
      confirmed: boolean
      protection: Parameters<typeof decidePluginOperation>[0]['protection']
      policy: Parameters<typeof decidePluginOperation>[0]['policy']
    }
  ): Promise<PluginOperationOutcomeView> {
    const outcome = await deployCandidate({
      store: this,
      token,
      ownerId,
      pluginsRoot: options.pluginsRoot,
      confirmed: options.confirmed,
      protection: options.protection,
      policy: options.policy,
      fetchBytes: this.deps.fetchBytes
    })
    return toOperationView(outcome)
  }

  async runOnce(
    ownerId: PluginSourceOwnerId,
    token: string,
    options: {
      pluginsRoot: string
      confirmed: boolean
      protection: Parameters<typeof decidePluginOperation>[0]['protection']
      policy: Parameters<typeof decidePluginOperation>[0]['policy']
      timeoutMs?: number
    }
  ): Promise<PluginOperationOutcomeView> {
    const outcome = await runCandidateOnce({
      store: this,
      token,
      ownerId,
      pluginsRoot: options.pluginsRoot,
      confirmed: options.confirmed,
      protection: options.protection,
      policy: options.policy,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs })
    })
    return toOperationView(outcome)
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

/**
 * The window's view of what happened: codes and parameters. The renderer owns the sentences.
 */
const toOperationView = (outcome: PluginOperationOutcome): PluginOperationOutcomeView => {
  if (outcome.state === 'deployed') {
    return {
      state: 'deployed',
      pluginId: outcome.deployment.pluginId,
      directory: outcome.deployment.directory,
      entries: outcome.deployment.entries.map((entry) => ({
        entry: entry.entry,
        bytes: entry.bytes,
        sha256: entry.sha256
      }))
    }
  }
  if (outcome.state === 'ran') {
    return {
      state: 'ran',
      command: outcome.run.command,
      exitCode: outcome.run.exitCode,
      signal: outcome.run.signal,
      timedOut: outcome.run.timedOut,
      stdout: outcome.run.stdout,
      stderr: outcome.run.stderr,
      durationMs: outcome.run.durationMs
    }
  }
  return { state: 'refused', reason: outcome.reason, detail: outcome.detail }
}
