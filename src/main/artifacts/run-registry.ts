type ArtifactRunClaim = {
  claimId: string
  projectName: string
  artifactSessionId: string
  sessionId: string
  runId: string
  artifactVersionIds?: string[]
  rootFrameId?: string
  agentFrameId?: string
  messageBranchId?: string
  messageBranchAncestry?: string[]
  messageAncestry?: string[]
  runtimeSegmentId?: string
  promptMessageId?: string
  finalizedMessageId?: string
  // How many finalize calls this claim has seen. The renderer retries a claim after losing the
  // durability race, so "the second attempt succeeded" is the normal recovered shape; without a counter
  // the field log cannot tell that apart from "the first attempt worked" (measured 2026-10-23T15:57Z:
  // 36 claims, 36 recorded failures, and no line at all for the attempt that published them).
  finalizeAttemptCount?: number
}

type RegisterArtifactRunClaimRequest = {
  projectName: string
  artifactSessionId: string
  sessionId: string
  runId: string
  artifactVersionIds?: string[]
  rootFrameId?: string
  agentFrameId?: string
  messageBranchId?: string
  messageBranchAncestry?: string[]
  messageAncestry?: string[]
  runtimeSegmentId?: string
  promptMessageId?: string
}

// Keeps short-lived artifact run ownership in memory until the renderer finalizes a message.
class ArtifactRunRegistry {
  private sequence = 0
  private readonly claims = new Map<string, ArtifactRunClaim>()

  // Registers one generated run and returns an opaque claim id for renderer finalization.
  register(request: RegisterArtifactRunClaimRequest): string {
    this.sequence += 1
    const claimId = `artifact-claim-${Date.now()}-${this.sequence}`

    this.claims.set(claimId, {
      claimId,
      ...request,
      artifactVersionIds: request.artifactVersionIds ? [...request.artifactVersionIds] : undefined
    })

    return claimId
  }

  // Resolves an opaque claim id back to the runtime-owned project/session/run tuple.
  resolve(claimId: string): ArtifactRunClaim {
    const claim = this.claims.get(claimId)

    if (!claim) {
      throw new Error(`Artifact run claim not found: ${claimId}`)
    }

    return claim
  }

  // Run ids of claims registered but not yet finalized — files that have been emitted to the renderer
  // and are awaiting its finalize call. The orphan scan must exclude these (a normal file mid-handoff,
  // not an orphan) in addition to prompt-in-flight runs, since a run leaves the runtime's active set at
  // stop, before the renderer finalizes. In-memory only, so a crash clears them and they resurface.
  getUnfinalizedRunIds(): string[] {
    const runIds: string[] = []
    for (const claim of this.claims.values()) {
      if (!claim.finalizedMessageId) runIds.push(claim.runId)
    }
    return runIds
  }

  // Records the message that consumed a claim so finalize retries remain idempotent.
  markFinalized(claimId: string, messageId: string): void {
    const claim = this.resolve(claimId)

    if (claim.finalizedMessageId && claim.finalizedMessageId !== messageId) {
      throw new Error(
        `Artifact run claim already finalized for message: ${claim.finalizedMessageId}`
      )
    }

    this.claims.set(claimId, {
      ...claim,
      finalizedMessageId: messageId
    })
  }

  // Counts one finalize call for a claim and returns its 1-based ordinal. The count lives on the claim
  // (not in the caller) because the renderer is what retries: two separate IPC calls must still add up to
  // "attempt 2", otherwise every retry would report itself as a first attempt and the recovered shape
  // would look identical to a fresh claim.
  noteFinalizeAttempt(claimId: string): number {
    const claim = this.resolve(claimId)
    const attempt = (claim.finalizeAttemptCount ?? 0) + 1

    this.claims.set(claimId, {
      ...claim,
      finalizeAttemptCount: attempt
    })
    return attempt
  }
}

export { ArtifactRunRegistry }
export type { ArtifactRunClaim, RegisterArtifactRunClaimRequest }
