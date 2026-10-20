// Capability contracts: what a scientific capability needs before it can run, and what it leaves
// behind. A skill or tool that declares one turns an opaque "call this function and hope" into a
// checkable statement: this step consumed these facts, produced those, and fails this way when it
// cannot run.
//
// Two deliberate narrowings:
//   1. The domain list is closed (STATE_FACT_DOMAINS). A new domain is a vocabulary decision, not a
//      side effect of adding a skill — and keeping `prediction` apart from `data` is what stops a
//      model-predicted structure from being consumed as a computed one.
//   2. Nothing here blocks execution. A contract produces a *reading* (ready / missing_state /
//      undeclared); the caller decides what to do with it. Contracts are for telling the truth about
//      state, not for gating science (G1).

import { parseFrontmatter } from './skill-frontmatter'

/** Fact domains a contract may speak about. Closed on purpose — see file header. */
export const STATE_FACT_DOMAINS = [
  'input',
  'data',
  'evidence',
  'artifact',
  'prediction',
  'review',
  'claim'
] as const

export type StateFactDomain = (typeof STATE_FACT_DOMAINS)[number]

/** A state fact token: `<domain>:<entity>` or `<domain>:<entity>:<qualifier>`. */
export type StateFact = string

/** How a contract step can fail, in the vocabulary the runtime reports. */
export const CAPABILITY_FAILURE_CLASSES = [
  'missing_state',
  'invalid_arguments',
  'unavailable_dependency',
  'incompatible_object',
  'failed_execution'
] as const

export type CapabilityFailureClass = (typeof CAPABILITY_FAILURE_CLASSES)[number]

export type CapabilityContract = {
  id: string
  /** Free-text names an agent or a person may use for this capability, including Chinese ones. */
  aliases: string[]
  /** Facts that must already hold. Empty means the capability is an entry point. */
  requires: StateFact[]
  /** Facts the capability establishes when it succeeds. */
  produces: StateFact[]
  /** Capability ids that must have run first, when state alone is not the whole precondition. */
  prerequisites: string[]
  /** Named repair hint per failure class. A class without an entry is reported as unhandled. */
  failurePolicy: Partial<Record<CapabilityFailureClass, string>>
}

export type ContractParseResult = {
  contract: CapabilityContract | null
  /** Machine-readable problems, named — never swallowed. Empty exactly when contract is non-null. */
  errors: string[]
}

const CONTRACT_KEYS = new Set([
  'id',
  'aliases',
  'requires',
  'produces',
  'prerequisites',
  'failure_policy'
])

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/
const FACT_RE = /^(input|data|evidence|artifact|prediction|review|claim):[a-z0-9_]+(:[a-z0-9_]+)?$/
const MAX_ALIASES = 16
const MAX_FACTS = 64
const MAX_ALIAS_LENGTH = 64

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const readStringArray = (
  value: unknown,
  field: string,
  errors: string[],
  opts: { max: number; maxLength?: number }
): string[] => {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    errors.push(`${field}_not_array`)
    return []
  }
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') {
      errors.push(`${field}_item_not_string`)
      continue
    }
    const trimmed = item.trim()
    if (!trimmed) {
      errors.push(`${field}_item_empty`)
      continue
    }
    if (opts.maxLength !== undefined && trimmed.length > opts.maxLength) {
      errors.push(`${field}_item_too_long`)
      continue
    }
    out.push(trimmed)
  }
  if (out.length > opts.max) errors.push(`${field}_too_many`)
  return out
}

const validateFacts = (facts: string[], field: string, errors: string[]): StateFact[] => {
  const seen = new Set<string>()
  const out: StateFact[] = []
  for (const fact of facts) {
    if (!FACT_RE.test(fact)) {
      errors.push(`${field}_invalid_fact:${fact}`)
      continue
    }
    if (seen.has(fact)) {
      errors.push(`${field}_duplicate:${fact}`)
      continue
    }
    seen.add(fact)
    out.push(fact)
  }
  return out
}

const validateFailurePolicy = (
  value: unknown,
  errors: string[]
): Partial<Record<CapabilityFailureClass, string>> => {
  if (value === undefined) return {}
  if (!isRecord(value)) {
    errors.push('failure_policy_not_object')
    return {}
  }
  const policy: Partial<Record<CapabilityFailureClass, string>> = {}
  for (const [key, raw] of Object.entries(value)) {
    if (!(CAPABILITY_FAILURE_CLASSES as readonly string[]).includes(key)) {
      errors.push(`failure_policy_unknown_class:${key}`)
      continue
    }
    if (typeof raw !== 'string' || !raw.trim()) {
      errors.push(`failure_policy_not_text:${key}`)
      continue
    }
    policy[key as CapabilityFailureClass] = raw.trim()
  }
  return policy
}

/**
 * Parses the JSON a `contract:` frontmatter value carries. The value is a single-line JSON string
 * on purpose: the frontmatter reader runs with a failsafe YAML schema that flattens nesting, so a
 * nested block would silently lose its structure instead of failing.
 */
export const parseContractField = (raw: string, expectedId?: string): ContractParseResult => {
  const text = raw.trim()
  if (!text) return { contract: null, errors: ['contract_empty'] }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { contract: null, errors: ['contract_not_json'] }
  }
  if (!isRecord(parsed)) return { contract: null, errors: ['contract_not_object'] }

  const errors: string[] = []
  for (const key of Object.keys(parsed)) {
    if (!CONTRACT_KEYS.has(key)) errors.push(`contract_unknown_key:${key}`)
  }

  const id = typeof parsed.id === 'string' ? parsed.id.trim() : ''
  if (!id) errors.push('id_missing')
  else if (!ID_RE.test(id)) errors.push(`id_invalid:${id}`)
  else if (expectedId !== undefined && id !== expectedId)
    errors.push(`id_mismatch:${id}!=${expectedId}`)

  const aliases = readStringArray(parsed.aliases, 'aliases', errors, {
    max: MAX_ALIASES,
    maxLength: MAX_ALIAS_LENGTH
  })
  const aliasSeen = new Set<string>()
  for (const alias of aliases) {
    const key = alias.toLowerCase()
    if (aliasSeen.has(key)) errors.push(`aliases_duplicate:${alias}`)
    aliasSeen.add(key)
  }

  const requires = validateFacts(
    readStringArray(parsed.requires, 'requires', errors, { max: MAX_FACTS }),
    'requires',
    errors
  )
  const produces = validateFacts(
    readStringArray(parsed.produces, 'produces', errors, { max: MAX_FACTS }),
    'produces',
    errors
  )
  const prerequisites = readStringArray(parsed.prerequisites, 'prerequisites', errors, {
    max: MAX_FACTS
  })
  for (const prerequisite of prerequisites) {
    if (!ID_RE.test(prerequisite)) errors.push(`prerequisites_invalid_id:${prerequisite}`)
    if (prerequisite === id) errors.push(`prerequisites_self:${prerequisite}`)
  }

  const failurePolicy = validateFailurePolicy(parsed.failure_policy, errors)

  if (errors.length) return { contract: null, errors }

  return {
    contract: { id, aliases, requires, produces, prerequisites, failurePolicy },
    errors: []
  }
}

/** Reads the contract a SKILL.md declares, if any. A skill without one is not an error. */
export const extractContract = (markdown: string, expectedId?: string): ContractParseResult => {
  const { fields } = parseFrontmatter(markdown)
  const raw = fields.contract
  if (raw === undefined) return { contract: null, errors: [] }
  return parseContractField(raw, expectedId)
}

/**
 * Ranks declared capabilities against a free-text request. Deterministic: score, then id.
 *
 * The single-query shape is what the missing-state advice needs ("which capability establishes this
 * fact?"); matching is deliberately lexical — a semantic source would be a different feature and is
 * not pre-wired here as dead code.
 */
export const rankCapabilities = (
  query: string,
  contracts: readonly CapabilityContract[],
  limit = 5
): { id: string; score: number; matched: string[] }[] => {
  const needle = query.trim().toLowerCase()
  if (!needle) return []
  const words = needle.split(/[\s,;/]+/).filter((word) => word.length > 1)

  const scored: { id: string; score: number; matched: string[] }[] = []
  for (const contract of contracts) {
    const idLower = contract.id.toLowerCase()
    let score = 0
    const matched: string[] = []

    if (needle === idLower) {
      score += 100
      matched.push(contract.id)
    }
    for (const alias of contract.aliases) {
      const aliasLower = alias.toLowerCase()
      if (needle === aliasLower) {
        score += 100
        matched.push(alias)
      } else if (
        aliasLower.length >= 2 &&
        (needle.includes(aliasLower) || aliasLower.includes(needle))
      ) {
        score += 60
        matched.push(alias)
      }
    }
    const idTokens = idLower.split(/[-._]/)
    for (const word of words) {
      if (idTokens.includes(word)) score += 8
    }
    if (score > 0) scored.push({ id: contract.id, score, matched: [...new Set(matched)] })
  }

  scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
  return scored.slice(0, Math.max(0, limit))
}
