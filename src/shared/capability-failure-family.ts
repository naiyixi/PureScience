// One vocabulary for failures, not two.
//
// Capability contracts name five ways a step can fail (missing_state / invalid_arguments /
// unavailable_dependency / incompatible_object / failed_execution). The rest of the app already speaks
// a family vocabulary when it reports a broken review. Shipping two vocabularies means a refused step
// arrives in the error panel as `unknown` — the one answer that tells the user nothing.
//
// This maps, and it is exhaustive by construction: adding a capability failure class without deciding
// its family fails the type check rather than silently reporting `unknown` forever.

import type { CapabilityFailureClass } from './capability-contract'

/** Same eight names the review error panel already classifies by. */
export const REVIEW_FAILURE_FAMILIES = [
  'persistence',
  'storage',
  'protocol',
  'budget',
  'provider',
  'runtime',
  'timeout',
  'unknown'
] as const

export type ReviewFailureFamily = (typeof REVIEW_FAILURE_FAMILIES)[number]

export const CAPABILITY_FAILURE_FAMILY: Record<CapabilityFailureClass, ReviewFailureFamily> = {
  // A precondition of this run is absent. Nothing was read or written and no remote service failed, so
  // the fault sits with the run itself — that is `runtime`, not `unknown` and not `storage`.
  missing_state: 'runtime',
  // The call did not match the interface the capability declares.
  invalid_arguments: 'protocol',
  // Something the app depends on (a service, a binary, a remote endpoint) could not serve.
  unavailable_dependency: 'provider',
  // An object on disk exists but cannot be used as declared (wrong shape, unreadable, corrupt).
  incompatible_object: 'storage',
  // The step ran and failed on its own terms.
  failed_execution: 'runtime'
}

export const failureFamilyFor = (failureClass: CapabilityFailureClass): ReviewFailureFamily =>
  CAPABILITY_FAILURE_FAMILY[failureClass]
