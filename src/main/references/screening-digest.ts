import { createHash } from 'node:crypto'

import type { ScreeningEvidenceCoverage } from '../../shared/references-screening'

// inputDigest (S2.1): a stable digest of exactly the inputs a screening decision is made from — the
// rule set's content hash, the model-facing policy identity, and the literature evidence text. It is
// the key a resume compares (S2.6): "same digest" means the record does not have to be looked at
// again, so the two properties below are the whole point of this module.
//
//   1. the same input digests the same way, twice, in any process — nothing here reads a clock, the
//      database, or the network;
//   2. any component moving changes the digest — a rule edit, a policy bump, or one character of the
//      evidence text. A digest that survived an evidence change would make a resume silently skip a
//      record whose grounds moved out from under its verdict.
//
// Because the digest hashes the same `sections` the prompt renders (see screening-prompt.ts), it can
// never describe text the model was not shown.

// The three evidence tiers as plain text. Named rather than positional so a caller cannot silently
// swap the abstract for the full text and digest a decision against the wrong passage.
export type ScreeningEvidenceSections = {
  metadata: string
  abstract: string
  fullText: string
}

export type ScreeningInputDigestInput = {
  // sha256 of the canonical rule JSON (screening-rules.ts). The rules are an input to the decision;
  // hashing the rule's content hash keeps the digest independent of how the criteria were written.
  ruleContentHash: string
  // Model + prompt-guardrail policy identity, so a guardrail change re-digests every record.
  policyKey: string
  // How much of the record was actually read. Part of the digest because a verdict decided from an
  // abstract and one decided from the full text are different inputs even if the rule set is equal.
  coverage: ScreeningEvidenceCoverage
  sections: ScreeningEvidenceSections
}

// Deterministic JSON: object keys sorted, array order preserved. JSON.stringify keeps insertion
// order, which is a property of how a caller built the object rather than of its value — two callers
// assembling the same evidence with keys added in different orders would otherwise hash differently.
const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`
}

const sha256Hex = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex')

export const serializeScreeningInputDigest = (input: ScreeningInputDigestInput): string =>
  canonicalJson({
    coverage: input.coverage,
    policyKey: input.policyKey,
    ruleContentHash: input.ruleContentHash,
    sections: {
      abstract: input.sections.abstract,
      fullText: input.sections.fullText,
      metadata: input.sections.metadata
    }
  })

// sha256 over the canonical form, hex. Compared, never interpreted — like the rule content hash it
// exists so two decisions can be proven to rest on the same input (or not) without diffing text.
export const computeScreeningInputDigest = (input: ScreeningInputDigestInput): string =>
  sha256Hex(serializeScreeningInputDigest(input))
