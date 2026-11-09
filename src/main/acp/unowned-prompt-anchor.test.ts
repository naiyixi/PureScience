import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

// An app-owned turn (a suppressed prompt: background delivery, screening inference, a reviewer
// correction) never becomes a Message node in the durable conversation graph, so the Prompt identity
// minted at dispatch cannot be owned by anything. An Artifact written by such a turn therefore fails
// its ownership proof terminally — this machine's own logs carried 20 such lines over four days
// (`prompt-<uuid>` declared, `message-…` in the graph). The fallback has to stay (legacy callers exist),
// but it may not stay silent: a reader of the log has to be able to tell "this turn's artifacts can
// never finalize" from "this turn wrote nothing".

const coordinatorSource = readFileSync(new URL('./runtime-coordinator.ts', import.meta.url), 'utf8')
const repositorySource = readFileSync(
  new URL('../artifacts/provenance-repository.ts', import.meta.url),
  'utf8'
)

const MINT_SITE = /`prompt-\$\{randomUUID\(\)\}`/gu

const declaredCauses = (): string[] => {
  const match = /export type ArtifactFinalizationProofCause =([\s\S]*?)\n\n/u.exec(repositorySource)
  if (!match?.[1]) throw new Error('ArtifactFinalizationProofCause was not found in the source')
  return [...match[1].matchAll(/'([a-z-]+)'/gu)].map((entry) => entry[1] as string)
}

describe('a prompt without conversation-graph provenance announces its consequence', () => {
  it('scans the two files this contract spans', () => {
    // Self-check: a moved file would leave every assertion below vacuously true.
    expect(coordinatorSource.length).toBeGreaterThan(10_000)
    expect(declaredCauses().length).toBeGreaterThan(10)
  })

  it('mints the fallback identity in exactly one place', () => {
    expect(coordinatorSource.match(MINT_SITE)?.length ?? 0).toBe(1)
  })

  it('names the proof rule that will refuse the turn, using a declared cause', () => {
    const consequence = /consequence: '([a-z-]+)'/u.exec(coordinatorSource)
    expect(consequence?.[1]).toBeDefined()
    // The wording must not drift away from the vocabulary the finalization proof actually uses: a log
    // that names a cause no rule ever constructs would send the next reader after a rule that does not
    // exist.
    expect(declaredCauses()).toContain(consequence?.[1])
    expect(repositorySource).toContain(`'${consequence?.[1]}'`)
  })

  it('warns once per session instead of once per turn', () => {
    expect(coordinatorSource).toContain('private readonly unownedPromptWarned = new Set<string>()')
    expect(coordinatorSource).toContain('this.unownedPromptWarned.has(request.sessionId)')
    expect(coordinatorSource).toContain('this.unownedPromptWarned.add(request.sessionId)')
    // Dedupe is only honest while the record follows the prompt that started it: the warning has to sit
    // in the same branch that mints the identity, not in a caller that may run before it.
    const mintIndex = coordinatorSource.search(MINT_SITE)
    const warnIndex = coordinatorSource.indexOf(
      'prompt dispatched without conversation-graph provenance'
    )
    expect(mintIndex).toBeGreaterThan(-1)
    expect(warnIndex).toBeGreaterThan(mintIndex)
    expect(warnIndex - mintIndex).toBeLessThan(800)
  })
})
