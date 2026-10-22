// Per-session capability preflight, in one place.
//
// Three callers need the same answer — "does this session satisfy capability X, and if not, what would
// establish it?" — and they must not drift: the headless HTTP route, the evidence collector, and the
// agent-facing preflight tool. Facts are therefore composed here from injected sources, so the same
// code runs against a real session store in production and against fixtures in tests.

import type { CapabilityContract, StateFact } from '../../shared/capability-contract'
import { factsForSession } from '../../shared/capability-session-facts'
import type { PreflightResult } from '../../shared/capability-preflight'
import { SkillCapabilityRegistry } from '../skills/skill-capability-registry'

export type SessionFactSources = {
  /** Files the user attached to messages (names, as the session records them). */
  attachments: { name: string }[]
  /** Artifacts the session produced, already resolved to names where possible. */
  artifacts: { path: string; name?: string }[]
  /** Skills the session's messages reference. A reference is not an execution. */
  referencedCapabilities: string[]
}

export type PreflightDeps = {
  /** Loads the facts a session contributes, or null when the session does not exist. */
  loadFacts: (sessionId: string) => Promise<SessionFactSources | null>
}

export type CapabilityPreflightPayload = {
  capability: string
  status: PreflightResult['status']
  reason: PreflightResult['reason']
  requires: StateFact[]
  produces: StateFact[]
  missing: PreflightResult['missing']
  suggested: string[]
  /** Facts the session holds, with the evidence behind each one. */
  facts: StateFact[]
  factSources: Record<StateFact, string[]>
  /** Named gaps: what this reading could NOT see, so "missing" is never read as "absent". */
  notes: string[]
  /** Declared capabilities in the same install, so the agent can see what else is available. */
  declared: string[]
}

export const buildCapabilityPreflight = async (input: {
  configRoot: string
  sessionId: string
  capability: string
  deps: PreflightDeps
}): Promise<CapabilityPreflightPayload | null> => {
  const registry = new SkillCapabilityRegistry(`${input.configRoot}/skills`)
  await registry.load()

  const declared: CapabilityContract[] = registry.declared()
  const contract = declared.find((entry) => entry.id === input.capability) ?? null
  const sources = await input.deps.loadFacts(input.sessionId)
  if (!sources) return null

  const facts = factsForSession(
    {
      attachments: sources.attachments,
      artifacts: sources.artifacts,
      usedCapabilities: sources.referencedCapabilities
    },
    declared
  )

  // "Installed but declared nothing" and "not installed at all" are different answers, and neither is
  // a pass. The registry throws for an unknown id, so the distinction is made before asking it.
  const installed = registry.get(input.capability) !== undefined
  const reading: PreflightResult = installed
    ? registry.preflight(input.capability, facts.facts)
    : {
        capabilityId: input.capability,
        status: 'undeclared',
        reason: 'no_contract',
        missing: [],
        suggested: []
      }

  const notes: string[] = []
  if (sources.referencedCapabilities.length) notes.push('used_capabilities_from_mentions')
  if (!installed) notes.push('unknown_capability')
  else if (!contract) notes.push('undeclared_capability')
  if (facts.problems.length) notes.push(...facts.problems)

  return {
    capability: input.capability,
    status: reading.status,
    reason: reading.reason,
    requires: contract?.requires ?? [],
    produces: contract?.produces ?? [],
    missing: reading.missing,
    suggested: reading.suggested,
    facts: facts.facts,
    factSources: facts.sources,
    notes,
    declared: declared.map((entry) => entry.id)
  }
}
