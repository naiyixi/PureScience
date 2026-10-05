// On-demand engine weights, as a *build-level* fact (IC42 slice 1).
//
// The fetch primitive (`src/main/engines/model-weight-cache.ts`) already refuses to download anything
// without a published checksum. What was missing is the truth about *this build*: whether there is any
// such checksum on file at all. Without it, two surfaces promised something that cannot happen — the
// compute skill doc told the agent an engine "needs user consent" (implying consent would enable it),
// and the folding router told the user to "enable on-demand downloads".
//
// So the spec list lives here, as data, and everything else is derived from it: an empty list means the
// build cannot download weights at all, and no engine that needs them can be enabled by approving
// anything. Naming the state is what keeps the honest answer cheap.

import type { EngineDefinition } from './engine-catalog'

/**
 * A weight artifact plus the publisher's checksum. Mirrors the fetch contract exactly; the main-process
 * primitive imports this type rather than declaring a second one, so the two cannot drift.
 */
export type EngineWeightSpec = Readonly<{
  modelId: string
  url: string
  bytes: number
  /** Published SHA256 (lowercase hex). Never optional: no checksum means no download. */
  sha256: string
  license: string
}>

/**
 * The weights this build may download.
 *
 * **Empty is a real state, not a placeholder.** No engine weight has a publisher-published checksum yet,
 * and the app refuses to fetch what it cannot verify — so today it downloads none of them. Populating
 * this list is a release decision (publisher, hosting location, `sha256`, bytes, licence), not something
 * code can invent: see `docs/plan-2026-10-03-M2-blocker-and-deferral.md`.
 */
export const ENGINE_WEIGHT_SPECS: readonly EngineWeightSpec[] = []

const isPublishedChecksum = (value: string): boolean => /^[0-9a-f]{64}$/.test(value)

/** The one rule for "may this build download weights?": something has to be on the list to download. */
export const weightDownloadPossible = (
  specs: readonly EngineWeightSpec[] = ENGINE_WEIGHT_SPECS
): boolean => specs.some((spec) => isPublishedChecksum(spec.sha256))

export const findEngineWeightSpec = (
  modelId: string,
  specs: readonly EngineWeightSpec[] = ENGINE_WEIGHT_SPECS
): EngineWeightSpec | undefined => specs.find((spec) => spec.modelId === modelId)

/**
 * What stands between an engine and its weights. Four states, and the two refusal states carry *why*
 * they refuse (a missing spec is not the same as a recorded checksum that is not a published SHA256).
 */
export type EngineWeightGate =
  | { state: 'not-needed'; engineId: string }
  | {
      state: 'unpublished'
      engineId: string
      reason: 'no-spec' | 'invalid-checksum'
      weightBytes: number
    }
  | { state: 'awaiting-consent'; engineId: string; spec: EngineWeightSpec }
  | { state: 'ready'; engineId: string; spec: EngineWeightSpec }

export const describeEngineWeightGate = (
  engine: EngineDefinition,
  options: { consent?: boolean; specs?: readonly EngineWeightSpec[] } = {}
): EngineWeightGate => {
  const needsWeights = engine.requirements.weightBytes > 0 && engine.requirements.onDemandDownload
  if (!needsWeights) return { state: 'not-needed', engineId: engine.id }
  const spec = findEngineWeightSpec(engine.id, options.specs)
  if (!spec) {
    return {
      state: 'unpublished',
      engineId: engine.id,
      reason: 'no-spec',
      weightBytes: engine.requirements.weightBytes
    }
  }
  if (!isPublishedChecksum(spec.sha256)) {
    return {
      state: 'unpublished',
      engineId: engine.id,
      reason: 'invalid-checksum',
      weightBytes: spec.bytes
    }
  }
  return options.consent
    ? { state: 'ready', engineId: engine.id, spec }
    : { state: 'awaiting-consent', engineId: engine.id, spec }
}

/**
 * Whether the gate makes the engine impossible in this build, whatever the user consents to. Callers
 * use this instead of re-reading the state, so "no checksum means no engine" has one home.
 */
export const weightGateBlocksEngine = (gate: EngineWeightGate): boolean =>
  gate.state === 'unpublished'

/** Agent- and log-facing wording (English by convention: instruction text is not localised). */
export const renderEngineWeightGateEnglish = (gate: EngineWeightGate): string => {
  switch (gate.state) {
    case 'not-needed':
      return 'weights: none required'
    case 'unpublished':
      return gate.reason === 'no-spec'
        ? 'weights: no publisher checksum is on file for this build — they cannot be downloaded, so do not offer a download and do not ask the user to approve one'
        : 'weights: the recorded checksum is not a published SHA256 — they cannot be downloaded'
    case 'awaiting-consent':
      return 'weights: awaiting the user\u2019s approval before any download (never downloaded silently)'
    case 'ready':
      return 'weights: the user approved this download in this build'
  }
}
