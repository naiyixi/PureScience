// The capabilities route's payload, kept out of the HTTP handler so it can be tested without a
// server, an auth cookie or a running app. The handler's job is to call this and write JSON.
//
// Honesty rules this file is built around:
//   • No session → no facts. The payload says `session: null`; it never reports every capability as
//     "ready" simply because nothing was asked.
//   • A session whose artifacts cannot be read → `session.status = 'unavailable'` with a named
//     reason. Empty facts and unread facts are different answers.
//   • What the session did not record is named (`used_capabilities_not_recorded`), not assumed.

import { join } from 'node:path'

import type { CapabilityFailureClass, StateFact } from '../../shared/capability-contract'
import type { PreflightResult } from '../../shared/capability-preflight'
import { factsForSession } from '../../shared/capability-session-facts'
import type { PersistedArtifact } from '../../shared/session-persistence'
import { SkillCapabilityRegistry } from '../skills/skill-capability-registry'

export type DeclaredCapabilitySummary = {
  id: string
  aliases: string[]
  requires: StateFact[]
  produces: StateFact[]
  prerequisites: string[]
  failurePolicy: Partial<Record<CapabilityFailureClass, string>>
}

export type SessionCapabilityReading = {
  id: string
  status: 'ready' | 'missing_state' | 'undeclared'
  missing: { fact: StateFact; producers: string[] }[]
  suggested: string[]
}

export type CapabilitiesPayload = {
  declared: DeclaredCapabilitySummary[]
  undeclared: string[]
  problems: string[]
  session:
    | null
    | { status: 'unavailable'; reason: string }
    | {
        status: 'read'
        id: string
        facts: StateFact[]
        factSources: Record<StateFact, string[]>
        problems: string[]
        notes: string[]
        readings: SessionCapabilityReading[]
      }
}

export type BuildCapabilitiesInput = {
  configRoot: string
  sessionId?: string | null
  /** Absent when the caller has no artifact store — the payload then says so instead of guessing. */
  listArtifacts?: (sessionId: string) => Promise<PersistedArtifact[]>
}

const summarise = (registry: SkillCapabilityRegistry): DeclaredCapabilitySummary[] =>
  registry.declared().map((contract) => ({
    id: contract.id,
    aliases: contract.aliases,
    requires: contract.requires,
    produces: contract.produces,
    prerequisites: contract.prerequisites,
    failurePolicy: contract.failurePolicy
  }))

const toReading = (id: string, result: PreflightResult): SessionCapabilityReading => ({
  id,
  status: result.status,
  missing: result.missing,
  suggested: result.suggested
})

export const buildCapabilitiesPayload = async (
  input: BuildCapabilitiesInput
): Promise<CapabilitiesPayload> => {
  const registry = new SkillCapabilityRegistry(join(input.configRoot, 'skills'))
  await registry.load()

  const base = {
    declared: summarise(registry),
    undeclared: registry.undeclared(),
    problems: registry.problems()
  }

  const sessionId = input.sessionId?.trim()
  if (!sessionId) return { ...base, session: null }
  if (!input.listArtifacts) {
    return {
      ...base,
      session: { status: 'unavailable', reason: 'artifact_store_unavailable' }
    }
  }

  const artifacts = await input.listArtifacts(sessionId)
  const facts = factsForSession(
    { artifacts: artifacts.map((artifact) => ({ path: artifact.path })) },
    registry.declared()
  )
  // What this route cannot see, named so a "missing" reading is never read as a claim about what the
  // session did: which skills it ran, and which files the user attached (the artifact store does not
  // carry attachments).
  const notes = ['used_capabilities_not_recorded', 'attachments_not_read']

  const readings = registry
    .declared()
    .map((contract) => toReading(contract.id, registry.preflight(contract.id, facts.facts)))

  return {
    ...base,
    session: {
      status: 'read',
      id: sessionId,
      facts: facts.facts,
      factSources: facts.sources,
      problems: facts.problems,
      notes,
      readings
    }
  }
}
