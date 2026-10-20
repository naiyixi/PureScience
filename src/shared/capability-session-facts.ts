// Composing a session's state facts from the three places a session actually records state:
// attachments (input facts), artifacts (artifact facts), and the capabilities the session ran
// (their declared `produces`). The pure part lives here; reading the stores is a caller's job, so
// this can be tested without a running app and cannot silently invent facts.
//
// An unknown capability id is a problem to report, not a fact to skip: "we ran something the
// registry does not know" is exactly the case where a preflight would otherwise read as ready.

import type { CapabilityContract } from './capability-contract'
import { deriveFacts, type FactEvidence } from './capability-facts'

export type SessionFactSources = {
  /** Attachment file names (not paths): the uploads store keeps the user-facing name. */
  attachments?: readonly { name: string }[]
  /** Artifact paths produced by the session. */
  artifacts?: readonly { path: string }[]
  /** Skill ids the session actually ran. */
  usedCapabilities?: readonly string[]
}

export type SessionFacts = FactEvidence & {
  /** Named problems that prevented a fact from being established. */
  problems: string[]
}

// Only extensions whose artifact type is unambiguous. A `.md` could be a report, a note or a plan,
// so it establishes nothing here.
const ARTIFACT_FACTS: readonly { match: (lower: string) => boolean; fact: string }[] = [
  {
    match: (name) => name.endsWith('.png') || name.endsWith('.svg') || name.endsWith('.jpg'),
    fact: 'artifact:figure'
  },
  { match: (name) => name.endsWith('.csv') || name.endsWith('.tsv'), fact: 'artifact:table' }
]

export const factsForSession = (
  sources: SessionFactSources,
  contracts: readonly CapabilityContract[]
): SessionFacts => {
  const byId = new Map(contracts.map((contract) => [contract.id, contract]))
  const problems: string[] = []

  const completed: { id: string; produces: readonly string[] }[] = []
  for (const id of sources.usedCapabilities ?? []) {
    const contract = byId.get(id)
    if (!contract) {
      problems.push(`unknown_capability:${id}`)
      continue
    }
    completed.push({ id, produces: contract.produces })
  }

  const base = deriveFacts({
    fileNames: (sources.attachments ?? []).map((attachment) => attachment.name),
    completed
  })

  const sourcesMap: Record<string, string[]> = { ...base.sources }
  const facts = [...base.facts]
  for (const artifact of sources.artifacts ?? []) {
    const lower = artifact.path.trim().toLowerCase()
    if (!lower) continue
    for (const rule of ARTIFACT_FACTS) {
      if (!rule.match(lower)) continue
      if (!facts.includes(rule.fact)) facts.push(rule.fact)
      const evidence = sourcesMap[rule.fact] ?? []
      const label = `artifact:${artifact.path.trim()}`
      if (!evidence.includes(label)) evidence.push(label)
      sourcesMap[rule.fact] = evidence
    }
  }

  return { facts, sources: sourcesMap, problems }
}
