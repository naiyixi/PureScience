import { describe, expect, it } from 'vitest'

import { createKnowledgeCitationVerifier, sha256Of } from './knowledge-citation'
import { createKnowledgeSearchService, type KnowledgeLexicalHit } from './knowledge-search-service'

const LOCATOR = { kind: 'file' as const, path: '/managed/notes.md', startLine: 4, endLine: 4 }

const hit = (text: string): KnowledgeLexicalHit => ({
  sourceId: 'source-1',
  label: 'notes.md',
  text,
  locator: LOCATOR
})

// The two halves that make a citation worth showing: its digest is recomputable by anyone, and a re-check
// that finds different bytes marks the row instead of displaying it as if nothing had moved.
describe('knowledge citations', () => {
  it('recomputes the digest and calls an unchanged location fresh', async () => {
    const text = 'the matched line'
    const verifier = createKnowledgeCitationVerifier({ reader: { read: async () => text } })

    const verdict = await verifier.verify({
      sourceId: 'source-1',
      locator: LOCATOR,
      sha256: sha256Of(text)
    })

    expect(verdict.state).toBe('fresh')
    expect(verdict.sha256).toBe(sha256Of(text))
  })

  it('marks a location whose bytes changed stale, and reports what is there now', async () => {
    const verifier = createKnowledgeCitationVerifier({
      reader: { read: async () => 'the line, edited' }
    })

    const verdict = await verifier.verify({
      sourceId: 'source-1',
      locator: LOCATOR,
      sha256: sha256Of('the matched line')
    })

    expect(verdict.state).toBe('stale')
    expect(verdict.sha256).toBe(sha256Of('the line, edited'))
  })

  it('calls an unreadable location unreadable — not stale, which would retire a citation nobody disproved', async () => {
    const verifier = createKnowledgeCitationVerifier({ reader: { read: async () => undefined } })

    expect(
      (await verifier.verify({ sourceId: 's', locator: LOCATOR, sha256: 'anything' })).state
    ).toBe('unreadable')
  })

  it('marks the row stale when the file moved, and leaves it alone when it did not', async () => {
    const service = (
      read: () => Promise<string | undefined>
    ): ReturnType<typeof createKnowledgeSearchService> =>
      createKnowledgeSearchService({
        lexical: {
          query: async () => ({
            hits: [hit('the matched line')],
            coverage: { indexed: 1, pending: 0 }
          })
        },
        verifier: createKnowledgeCitationVerifier({ reader: { read } })
      })

    const fresh = await service(async () => 'the matched line').search({ text: 'matched' })
    expect(fresh.verification).toBe('checked')
    expect(fresh.results[0]?.stale).toBeUndefined()
    expect(fresh.results[0]?.sha256).toBe(sha256Of('the matched line'))

    const moved = await service(async () => 'the line, edited').search({ text: 'matched' })
    expect(moved.results[0]?.stale).toBe(true)
  })

  it('never pretends a row was checked when no verifier is configured', async () => {
    const service = createKnowledgeSearchService({
      lexical: {
        query: async () => ({
          hits: [hit('the matched line')],
          coverage: { indexed: 1, pending: 0 }
        })
      }
    })

    const response = await service.search({ text: 'matched' })

    expect(response.verification).toBe('not-configured')
    expect(response.results[0]?.stale).toBeUndefined()
  })
})
