// The capabilities route's payload, kept out of the HTTP handler so it can be tested without a
// server, an auth cookie or a running app. The handler's job is to call this and write JSON.
//
// Honesty rules this file is built around:
//   • No session → no facts. The payload says `session: null`; it never reports every capability as
//     "ready" simply because nothing was asked.
//   • A session whose artifacts cannot be read → `session.status = 'unavailable'` with a named
//     reason. Empty facts and unread facts are different answers.
//   • A skill a message MENTIONS is not a skill that RAN. That distinction travels as a note,
//     because a preflight that treated a mention as execution would report a fact nobody
//     established.

import type { CapabilityFailureClass, StateFact } from '../../shared/capability-contract'
import type { PreflightResult } from '../../shared/capability-preflight'
import { renderCapabilityGaps } from '../../shared/capability-preflight-prompt'
import { factsForSession } from '../../shared/capability-session-facts'
import type { PersistedArtifact } from '../../shared/session-persistence'
import { SkillCapabilityRegistry } from '../skills/skill-capability-registry'
import { skillCapabilityRoots } from '../capabilities/skill-roots'

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

/** What a session contributes besides its artifacts. */
export type SessionInputs = {
  found: boolean
  /** Files the user attached to messages in this session. */
  attachments: { name: string }[]
  /** Skill ids the session's messages reference. A reference is not an execution. */
  usedCapabilities: string[]
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
        /**
         * The same gaps phrased as prompt text, ready to prepend to a turn. Null means every declared
         * capability is satisfied — a meaningful answer, not a missing one.
         */
        promptBlock: string | null
      }
}

export type BuildCapabilitiesInput = {
  configRoot: string
  sessionId?: string | null
  /** Absent when the caller has no artifact store — the payload then says so instead of guessing. */
  listArtifacts?: (sessionId: string) => Promise<PersistedArtifact[]>
  /** Absent when the caller cannot read session records; the payload then names that gap. */
  loadSession?: (sessionId: string) => Promise<SessionInputs>
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
  const registry = new SkillCapabilityRegistry(skillCapabilityRoots(input.configRoot))
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
  const inputs = input.loadSession ? await input.loadSession(sessionId) : null
  if (inputs && !inputs.found) {
    return { ...base, session: { status: 'unavailable', reason: 'session_not_found' } }
  }

  const facts = factsForSession(
    {
      attachments: inputs?.attachments ?? [],
      artifacts: artifacts.map((artifact) => ({ path: artifact.path })),
      usedCapabilities: inputs?.usedCapabilities ?? []
    },
    registry.declared()
  )

  // Named gaps keep a "missing" reading from being read as a claim about what the session did.
  const notes: string[] = []
  if (!inputs) notes.push('session_inputs_unavailable')
  else if (inputs.usedCapabilities.length) notes.push('used_capabilities_from_mentions')

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
      readings,
      promptBlock: renderCapabilityGaps({
        selected: readings.filter((reading) => reading.status === 'missing_state').map((r) => r.id),
        contracts: registry.declared().map((contract) => ({
          id: contract.id,
          requires: contract.requires,
          produces: contract.produces
        })),
        facts: facts.facts
      })
    }
  }
}
