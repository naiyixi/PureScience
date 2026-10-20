// Turning what a session actually holds into state facts a contract can be checked against.
//
// Two rules keep this honest:
//   1. Only unambiguous evidence yields a fact. A `.fasta` may be nucleotide or protein, so it
//      establishes nothing; guessing there would make the whole preflight read like a claim.
//   2. Every fact carries the evidence that established it. A fact with no named source is not
//      derivable here and must be supplied by a caller that does have one (a completed capability
//      run, a self-declared input), never invented by this module.

import type { StateFact } from './capability-contract'

export type FactEvidence = {
  facts: StateFact[]
  /** Fact → the evidence strings that established it, in a stable order. */
  sources: Record<StateFact, string[]>
}

export type DerivableInput = {
  /** Files the user attached or the session produced, by file name only. */
  fileNames?: readonly string[]
  /** Capabilities that completed in this session, with the facts they declared producing. */
  completed?: readonly { id: string; produces: readonly StateFact[] }[]
}

// Extensions whose meaning is unambiguous for our fact vocabulary. Anything else is deliberately
// absent: adding an entry here is a claim about what the file IS, not about its name.
const FILE_FACTS: readonly { match: (lower: string) => boolean; fact: StateFact }[] = [
  {
    match: (name) =>
      name.endsWith('.h5ad') ||
      name.endsWith('.h5mu') ||
      name.endsWith('.h5') ||
      name.endsWith('.loom') ||
      name.endsWith('.mtx') ||
      name.endsWith('.vcf') ||
      name.endsWith('.vcf.gz'),
    fact: 'input:omics_file'
  },
  {
    match: (name) =>
      name.endsWith('.csv') ||
      name.endsWith('.tsv') ||
      name.endsWith('.xlsx') ||
      name.endsWith('.parquet'),
    fact: 'input:table'
  },
  {
    match: (name) =>
      name.endsWith('.bib') ||
      name.endsWith('.ris') ||
      name.endsWith('.enl') ||
      name.endsWith('.nbib'),
    fact: 'input:reference_list'
  }
]

const addFact = (acc: Map<StateFact, string[]>, fact: StateFact, evidence: string): void => {
  const existing = acc.get(fact) ?? []
  if (!existing.includes(evidence)) existing.push(evidence)
  acc.set(fact, existing)
}

/**
 * @returns facts plus their evidence. Facts are ordered as first established (files in the order
 * given, then completed capabilities in the order given), so a caller can show "why" next to "what".
 */
export const deriveFacts = (input: DerivableInput): FactEvidence => {
  const acc = new Map<StateFact, string[]>()

  for (const name of input.fileNames ?? []) {
    const lower = name.trim().toLowerCase()
    if (!lower) continue
    for (const rule of FILE_FACTS) {
      if (rule.match(lower)) addFact(acc, rule.fact, `file:${name.trim()}`)
    }
  }

  for (const run of input.completed ?? []) {
    for (const fact of run.produces) addFact(acc, fact, `capability:${run.id}`)
  }

  const sources: Record<StateFact, string[]> = {}
  for (const [fact, evidence] of acc) sources[fact] = evidence
  return { facts: [...acc.keys()], sources }
}
