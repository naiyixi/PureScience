// Machine check: replay real failures through the classifier and report five-class coverage.
//
// The corpus is frozen on purpose (`docs/evidence/capability-failure-corpus.jsonl`) and every entry is
// checked against the file it cites — a message that does not literally appear in its source is not a
// real failure sample, and the test refuses it rather than letting the coverage number be manufactured.
//
// What "coverage" means here: of the replayed messages, how many land in one of the five contract
// failure classes. `null` means this classifier could not place it, which is a real result and is counted
// as uncovered — never folded into `failed_execution` to make the number look better.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { CAPABILITY_FAILURE_CLASSES, type CapabilityFailureClass } from './capability-contract'
import { classifyCapabilityFailure } from './capability-failure-classify'

type Sample = { source: string; message: string }

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..')
const corpusPath = join(repoRoot, 'docs', 'evidence', 'capability-failure-corpus.jsonl')

const loadCorpus = (): Sample[] =>
  readFileSync(corpusPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Sample)

describe('capability failure replay', () => {
  const corpus = loadCorpus()

  it('only cites messages that literally appear in the file they name', () => {
    const offenders: string[] = []
    for (const sample of corpus) {
      const text = readFileSync(join(repoRoot, sample.source), 'utf8')
      if (!text.includes(sample.message)) offenders.push(`${sample.source}: ${sample.message}`)
    }
    // A fabricated sample would make the coverage number meaningless.
    expect(offenders).toEqual([])
  })

  it('classifies at least 90% of the replayed failures into one of the five classes', () => {
    const counts = new Map<CapabilityFailureClass | 'unclassified', number>()
    const unclassified: string[] = []
    for (const sample of corpus) {
      const placed = classifyCapabilityFailure(sample.message)
      if (placed === null) unclassified.push(sample.message)
      const key = placed ?? 'unclassified'
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }

    const covered = corpus.length - unclassified.length
    const rate = covered / Math.max(1, corpus.length)
    // The number is printed so a regression is diagnosable from CI output alone.
    console.log(
      `[failure-replay] n=${corpus.length} covered=${covered} rate=${(rate * 100).toFixed(1)}% ` +
        `classes=${JSON.stringify(Object.fromEntries(counts))}`
    )
    if (unclassified.length > 0)
      console.log(`[failure-replay] unclassified: ${JSON.stringify(unclassified)}`)

    expect(rate).toBeGreaterThanOrEqual(0.9)
  })

  it('never invents a class it does not define', () => {
    for (const sample of corpus) {
      const placed = classifyCapabilityFailure(sample.message)
      if (placed === null) continue
      expect(CAPABILITY_FAILURE_CLASSES).toContain(placed)
    }
  })
})
