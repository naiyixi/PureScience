import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { ALL_CONNECTOR_IDS, getConnectorTools } from './registry'

// The maturity block in both READMEs states how many scientific connectors and tools ship. That number
// went stale the moment a connector was added, and the release page now repeats the block verbatim, so
// the claim is pinned to the registry here rather than trusted.
const READMES = ['README.md', 'README.en.md']

// The same count is stated in prose a reader meets BEFORE the maturity block: the intro line and the
// connector sentence in both READMEs, plus twice in ROADMAP.md. An earlier fix corrected only the
// maturity block, so those kept claiming 24 connectors while the registry shipped 31. Listing the files
// here is deliberate — a file that stops stating the count fails the guard below rather than quietly
// leaving the claim unchecked, and a new outward file has to be added on purpose.
const COUNT_CLAIM_FILES = ['README.md', 'README.en.md', 'ROADMAP.md']

const read = (name: string): string =>
  readFileSync(resolve(__dirname, '..', '..', '..', name), 'utf8')

const readClaim = (name: string): { connectors: number; tools: number } => {
  const match = read(name).match(/(\d+) connectors \((\d+) tools/)
  if (!match) throw new Error(`${name} does not state the connector and tool counts`)
  return { connectors: Number(match[1]), tools: Number(match[2]) }
}

// Every way the outward files phrase it: "31 built-in scientific connectors" (intro),
// "**31 built-in** research connectors" (body), "31 built-in connectors" (tables), "31 connectors (282 tools".
const phrasings = [
  /(\d+)\s+built-in\*{0,2}\s+(?:research\s+|scientific\s+)?connectors/gi,
  /(\d+)\s+connectors\s+\(/gi
]

const readCounts = (name: string): number[] =>
  phrasings.flatMap((pattern) => [...read(name).matchAll(pattern)].map((match) => Number(match[1])))

// "282 tools" / "282 callable tools" — the tool total is stated in the maturity block and, since this
// guard landed, in ROADMAP.md too. Wherever a file states it, it has to be the registry's number; a file
// that drops the sentence is allowed to (only the connector count is required to be present).
const readToolCounts = (name: string): number[] =>
  [...read(name).matchAll(/(\d+)\s+(?:callable\s+)?tools/gi)].map((match) => Number(match[1]))

// The body sentence enumerates the connectors by their human-readable names. Those names exist only in
// that sentence (the catalog carries Chinese display names, the descriptors carry comments), so the
// names themselves have no source to check against — the NUMBER does, and the count is what drifted.
const readEnumeratedNames = (name: string): string[] => {
  const match = read(name).match(/research connectors:\s*([^.]*)\./)
  if (!match) throw new Error(`${name} does not enumerate the connectors`)
  return match[1]
    .split(/,\s*|\s+and\s+/)
    .map((part) => part.trim())
    .filter(Boolean)
}

describe('README connector counts', () => {
  it('match the registry that actually ships', () => {
    const actual = {
      connectors: ALL_CONNECTOR_IDS.length,
      tools: ALL_CONNECTOR_IDS.reduce((sum, id) => sum + getConnectorTools(id).length, 0)
    }
    const claims = READMES.map((name) => ({ name, ...readClaim(name) }))

    for (const claim of claims) {
      expect({ name: claim.name, connectors: claim.connectors }).toEqual({
        name: claim.name,
        connectors: actual.connectors
      })
      expect({ name: claim.name, tools: claim.tools }).toEqual({
        name: claim.name,
        tools: actual.tools
      })
    }
  })

  it('are stated by every outward file, and never a stale number', () => {
    const actual = ALL_CONNECTOR_IDS.length

    for (const name of COUNT_CLAIM_FILES) {
      const counts = readCounts(name)
      expect({ name, stated: counts.length > 0 }).toEqual({ name, stated: true })
      // A file may state it more than once; no statement may disagree with the registry.
      expect({ name, distinct: [...new Set(counts)] }).toEqual({ name, distinct: [actual] })
    }
  })

  it('enumerate exactly as many connectors as the registry ships, in both READMEs', () => {
    for (const name of READMES) {
      expect({ name, listed: readEnumeratedNames(name).length }).toEqual({
        name,
        listed: ALL_CONNECTOR_IDS.length
      })
    }
  })

  it('never state a tool count that disagrees with the registry', () => {
    const total = ALL_CONNECTOR_IDS.reduce((sum, id) => sum + getConnectorTools(id).length, 0)

    for (const name of COUNT_CLAIM_FILES) {
      for (const count of readToolCounts(name)) {
        expect({ name, count }).toEqual({ name, count: total })
      }
    }
  })
})
