// Preflight: reading a capability's declared requirements against the facts the session actually
// holds. It reports; it never blocks. A missing requirement comes back with the capabilities that
// could establish it, so "this step cannot run" always arrives with "run this first" attached.

import type { CapabilityContract, CapabilityFailureClass, StateFact } from './capability-contract'

export type PreflightStatus = 'ready' | 'missing_state' | 'undeclared'

export type MissingFact = {
  fact: StateFact
  /** Capabilities that declare this fact as produced. Sorted, never includes the asked capability. */
  producers: string[]
}

export type PreflightResult = {
  capabilityId: string
  status: PreflightStatus
  /** Stable code the UI layer translates — this module never carries prose a user reads. */
  reason: 'all_requirements_met' | 'missing_requirements' | 'no_contract'
  missing: MissingFact[]
  /** Deduped capability ids worth running first, in the order the gaps were declared. */
  suggested: string[]
  failure?: { class: CapabilityFailureClass; repair: string | null }
}

/** Fact → capability ids that produce it. Built once per registry load. */
export const indexProducers = (
  contracts: readonly CapabilityContract[]
): Map<StateFact, string[]> => {
  const index = new Map<StateFact, Set<string>>()
  for (const contract of contracts) {
    for (const fact of contract.produces) {
      const owners = index.get(fact) ?? new Set<string>()
      owners.add(contract.id)
      index.set(fact, owners)
    }
  }
  const out = new Map<StateFact, string[]>()
  for (const [fact, owners] of index)
    out.set(
      fact,
      [...owners].sort((a, b) => a.localeCompare(b))
    )
  return out
}

/**
 * @param contract the capability's declaration, or null when it declared none
 * @param observed facts the session holds right now
 * @param producers index from indexProducers()
 */
export const preflightCapability = (
  contract: CapabilityContract | null,
  observed: Iterable<StateFact>,
  producers: Map<StateFact, string[]>
): PreflightResult => {
  if (!contract) {
    // Declaring nothing is not the same as needing nothing: say so instead of reporting ready.
    return {
      capabilityId: '',
      status: 'undeclared',
      reason: 'no_contract',
      missing: [],
      suggested: []
    }
  }

  const held = observed instanceof Set ? (observed as Set<StateFact>) : new Set(observed)
  const missing: MissingFact[] = []
  for (const fact of contract.requires) {
    if (held.has(fact)) continue
    const owners = (producers.get(fact) ?? []).filter((id) => id !== contract.id)
    missing.push({ fact, producers: owners })
  }

  if (!missing.length) {
    return {
      capabilityId: contract.id,
      status: 'ready',
      reason: 'all_requirements_met',
      missing: [],
      suggested: []
    }
  }

  const suggested: string[] = []
  for (const gap of missing) {
    for (const producer of gap.producers) {
      if (!suggested.includes(producer)) suggested.push(producer)
    }
  }

  return {
    capabilityId: contract.id,
    status: 'missing_state',
    reason: 'missing_requirements',
    missing,
    suggested,
    failure: {
      class: 'missing_state',
      repair: contract.failurePolicy.missing_state?.trim()
        ? contract.failurePolicy.missing_state
        : null
    }
  }
}
