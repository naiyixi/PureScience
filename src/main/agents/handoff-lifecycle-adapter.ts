import type {
  HandoffLifecycleChange,
  HandoffLifecycleEvent,
  HandoffTarget
} from '../../shared/handoff-lifecycle'
import type { CompletionHandoffLifecycleEvent } from '../../shared/specialist'

// U29 — the transport adapter between the two handoff seams.
//
// The window's seam (`handoff-lifecycle:*`) and the production lifecycle are NOT two implementations of
// one thing, which is what U22 assumed when it migrated the window onto the new face: the production
// `CompletionHandoffLifecycle` owns the state (and persists it), while the new seam is a read-only
// projection for the window. So this module converts the owner's events into the seam's shape, and the
// seam's channels are served by the owner rather than by a parallel lifecycle nothing ever installed.
//
// The conversion is deliberately total and non-inventing: every field the seam requires is either
// carried across or narrowed explicitly, and a summary is omitted rather than synthesised when the
// owner's record does not carry what the seam's shape asks for.

// `target: null` means the turn continues in the main session; the seam spells that `{ kind: 'main' }`.
export const toHandoffTarget = (target: string | null): HandoffTarget =>
  target === null ? { kind: 'main' } : { kind: 'specialist', name: target }

const isHandoffTarget = (value: unknown): value is HandoffTarget => {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { kind?: unknown; name?: unknown }
  if (candidate.kind === 'main') return true
  return candidate.kind === 'specialist' && typeof candidate.name === 'string'
}

const toContinuation = (
  event: CompletionHandoffLifecycleEvent
): HandoffLifecycleEvent['continuation'] => {
  const captured = event.continuation
  if (!captured) return undefined
  // The seam's summary carries the switch readback's target. The owner keeps that readback opaque, so it
  // is only used when it really is a handoff target — otherwise the summary is dropped rather than
  // rebuilt from the handoff's own target, which would assert something the record does not say.
  const readback = captured.switchReadback as { target?: unknown } | undefined
  const target = readback?.target
  if (!isHandoffTarget(target)) return undefined

  return {
    outcome: captured.outcome === 'threw' ? 'threw' : 'returned',
    switchReadback: { target }
  }
}

export const toHandoffLifecycleEvent = (
  event: CompletionHandoffLifecycleEvent
): HandoffLifecycleEvent => ({
  id: event.id,
  sessionId: event.sessionId,
  // The seam promises monotonic ordering within a handoff and must never regress on a late delivery.
  // commitOrder is the repository's globally monotonic stamp, assigned atomically with every transition;
  // records written before that field existed fall back to their own per-record sequence, which is
  // monotonic within the record the seam is ordering.
  sequence: event.commitOrder ?? event.sequence,
  observedAt: event.observedAt,
  phase: event.phase,
  target: toHandoffTarget(event.target),
  provenance: {
    originatingTurnId: event.provenance.originatingTurnId,
    // Optional on the owner's records, required by the seam. An absent id is reported as empty rather
    // than invented; the turn id either way is the one consumers group by.
    originatingUserMessageId: event.provenance.originatingUserMessageId ?? '',
    attachmentIds: event.provenance.attachmentIds,
    artifactIds: event.provenance.artifactIds
  },
  ...(toContinuation(event) ? { continuation: toContinuation(event) } : {}),
  ...(event.failure
    ? { failure: { retryFrom: event.failure.retryFrom, message: event.failure.message } }
    : {})
})

// The owner marks a rejected/cancelled approval with `removed`, which the seam expresses as a change that
// names the ids to drop.
export const toHandoffLifecycleChange = (
  event: CompletionHandoffLifecycleEvent
): HandoffLifecycleChange =>
  event.removed
    ? { kind: 'remove', sessionId: event.sessionId, eventIds: [event.id] }
    : { kind: 'upsert', event: toHandoffLifecycleEvent(event) }
