import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

// A terminal finalization rejection is never retried, so the only thing a later reader can act on is
// *which* proof rule refused the claim. The user's own log carried 20 such lines that said nothing but
// `invalid-proof` — the same claim retried 15 times over four days — and each one cost a reproduction to
// interpret. These assertions pin the vocabulary at the source level: every construction site names a
// declared cause, and every declared cause is reachable, so the field cannot decay back into a constant.

const repositorySource = readFileSync(
  new URL('./provenance-repository.ts', import.meta.url),
  'utf8'
)
const handlerSource = readFileSync(new URL('./ipc.ts', import.meta.url), 'utf8')
const scannedSources: ReadonlyArray<readonly [string, string]> = [
  ['provenance-repository.ts', repositorySource],
  ['ipc.ts', handlerSource]
]

const CONSTRUCTION = /new Artifact(?:FinalizationProof|OwnershipPersistenceRace)Error\(/gu
const NAMED_CONSTRUCTION =
  /new Artifact(?:FinalizationProof|OwnershipPersistenceRace)Error\(\s*'([a-z-]+)'/gu

const declaredCauses = (): string[] => {
  const match = /export type ArtifactFinalizationProofCause =([\s\S]*?)\n\n/u.exec(repositorySource)
  if (!match?.[1]) throw new Error('ArtifactFinalizationProofCause was not found in the source')
  return [...match[1].matchAll(/'([a-z-]+)'/gu)].map((entry) => entry[1] as string)
}

const countOf = (source: string, pattern: RegExp): number => source.match(pattern)?.length ?? 0

const namedCauses = (source: string): string[] =>
  [...source.matchAll(NAMED_CONSTRUCTION)].map((entry) => entry[1] as string)

describe('artifact finalization names its rejection cause', () => {
  it('scans the two files that construct proof rejections', () => {
    // Self-check: a broken path or a moved file would leave every assertion below vacuously true.
    expect(scannedSources).toHaveLength(2)
    for (const [name, source] of scannedSources) {
      expect(source.length, name).toBeGreaterThan(1000)
    }
  })

  it('names a cause at every construction site', () => {
    let total = 0
    for (const [name, source] of scannedSources) {
      const constructions = countOf(source, CONSTRUCTION)
      const named = countOf(source, NAMED_CONSTRUCTION)
      // An unnamed site is the defect this guard exists for: it compiles, logs `invalid-proof`, and
      // tells the next reader nothing.
      expect(named, `${name}: constructions=${constructions} named=${named}`).toBe(constructions)
      total += constructions
    }
    expect(total).toBeGreaterThanOrEqual(18)
  })

  it('keeps the declared vocabulary and the used vocabulary identical', () => {
    const declared = declaredCauses()
    expect(declared.length).toBeGreaterThanOrEqual(17)

    const used = scannedSources.flatMap(([, source]) => namedCauses(source))
    // Both directions matter: an undeclared code would not type-check, and a declared-but-unused code is
    // a rule nobody reports — the drift that made this field necessary in the first place.
    expect([...new Set(used)].sort()).toEqual([...new Set(declared)].sort())
  })
})
