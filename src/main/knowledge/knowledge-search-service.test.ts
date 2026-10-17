import { createHash } from 'node:crypto'

import { describe, expect, it, vi } from 'vitest'

import { createKnowledgeSearchService, type KnowledgeLexicalHit } from './knowledge-search-service'

const hit = (overrides: Partial<KnowledgeLexicalHit> = {}): KnowledgeLexicalHit => ({
  sourceId: 'source-1',
  label: 'notes.md',
  text: 'the matched line',
  locator: { kind: 'file', path: '/managed/notes.md', startLine: 4, endLine: 4 },
  ...overrides
})

// Two halves: what a hit carries (a citation anyone can recompute), and the three answers that must never
// be conflated — matches, no matches, and an index that still owes work.
describe('knowledge search (lexical only)', () => {
  it('cites the exact bytes: the digest is recomputed from the matched text', async () => {
    const service = createKnowledgeSearchService({
      lexical: { query: async () => ({ hits: [hit()], coverage: { indexed: 4, pending: 0 } }) }
    })

    const response = await service.search({ text: 'matched' })

    expect(response.status).toBe('ok')
    expect(response.mode).toBe('lexical')
    expect(response.degradation).toBe('semantic-source-unconfigured')
    // sha256('the matched line') — recomputed here, not copied from the service.
    expect(response.results[0]?.sha256).toBe(
      '551077b2422661016cb1ab4f843c2e12a6510cafa2fb6f3135a0867844073584'
    )
    expect(response.results[0]?.lexicalOnly).toBe(true)
    expect(response.results[0]?.locator).toEqual({
      kind: 'file',
      path: '/managed/notes.md',
      startLine: 4,
      endLine: 4
    })
  })

  it('says no-matches only when the index owes nothing', async () => {
    const service = createKnowledgeSearchService({
      lexical: { query: async () => ({ hits: [], coverage: { indexed: 9, pending: 0 } }) }
    })

    expect((await service.search({ text: 'nothing' })).status).toBe('no-matches')
  })

  it('says not-indexed — never no-matches — while the index still owes work', async () => {
    const service = createKnowledgeSearchService({
      lexical: { query: async () => ({ hits: [], coverage: { indexed: 9, pending: 3 } }) }
    })

    const response = await service.search({ text: 'nothing yet' })

    expect(response.status).toBe('not-indexed')
    expect(response.coverage).toEqual({ indexed: 9, pending: 3 })
  })

  it('never claims semantic: no mode but lexical, and every row says lexicalOnly', async () => {
    const query = vi.fn(async () => ({
      hits: [hit(), hit({ sourceId: 'source-2' })],
      coverage: { indexed: 2, pending: 0 }
    }))
    const service = createKnowledgeSearchService({ lexical: { query } })

    const response = await service.search({ text: 'matched', limit: 1 })

    expect(query).toHaveBeenCalledTimes(1)
    expect(response.mode).toBe('lexical')
    expect(response.results).toHaveLength(1)
    expect(response.results.every((result) => result.lexicalOnly === true)).toBe(true)
    expect(Object.keys(response)).not.toContain('semanticResults')
  })
})

// v2.6.0 A1: an embedding source is consulted when there is one, and every way it can fail to
// contribute has its own answer. A lexical list must never travel under a hybrid label.
describe('knowledge search (hybrid)', () => {
  const semanticHit = (
    overrides: Partial<{
      sourceId: string
      label: string
      text: string
      score: number
      locator: KnowledgeLexicalHit['locator']
    }> = {}
  ): {
    sourceId: string
    label: string
    text: string
    locator: KnowledgeLexicalHit['locator']
    score: number
  } => ({
    sourceId: 'source-1',
    label: 'notes.md',
    text: 'the matched line',
    locator: { kind: 'file', path: '/managed/notes.md', startLine: 4, endLine: 4 },
    score: 0.8,
    ...overrides
  })

  it('reports hybrid, marks agreement, and cites the semantic row’s own bytes', async () => {
    const service = createKnowledgeSearchService({
      lexical: { query: async () => ({ hits: [hit()], coverage: { indexed: 3, pending: 0 } }) },
      semantic: {
        query: async () => ({
          hits: [
            semanticHit(),
            semanticHit({
              sourceId: 'source-2',
              label: 'other.md',
              text: 'a semantically adjacent line',
              locator: { kind: 'file', path: '/managed/other.md', startLine: 9, endLine: 9 },
              score: 0.55
            })
          ],
          model: 'embed-small',
          dimensions: 768
        })
      }
    })

    const response = await service.search({ text: 'matched' })

    expect(response.mode).toBe('hybrid')
    expect(response.degradation).toBeUndefined()
    const bySource = new Map(response.results.map((result) => [result.sourceId, result]))
    expect(bySource.get('source-1')?.matchedBy).toBe('both')
    expect(bySource.get('source-2')?.matchedBy).toBe('semantic')
    // A hybrid response says nothing is lexical-only: that flag belongs to the lexical mode.
    expect(response.results.every((result) => result.lexicalOnly === undefined)).toBe(true)
    // The digest of the semantic-only row is recomputed from its own text.
    expect(bySource.get('source-2')?.sha256).toBe(
      createHash('sha256').update('a semantically adjacent line', 'utf8').digest('hex')
    )
  })

  it('names a failed semantic source instead of reading like the end of the corpus', async () => {
    const service = createKnowledgeSearchService({
      lexical: { query: async () => ({ hits: [hit()], coverage: { indexed: 3, pending: 0 } }) },
      semantic: {
        query: async () => {
          throw new Error('embedding endpoint refused')
        }
      }
    })

    const response = await service.search({ text: 'matched' })

    expect(response.mode).toBe('lexical')
    expect(response.degradation).toBe('semantic-source-failed')
    expect(response.results[0]?.lexicalOnly).toBe(true)
  })

  it('reports a source that answered with nothing as empty, not as unconfigured', async () => {
    const service = createKnowledgeSearchService({
      lexical: { query: async () => ({ hits: [hit()], coverage: { indexed: 3, pending: 0 } }) },
      semantic: {
        query: async () => ({ hits: [], model: 'embed-small', dimensions: 768 })
      }
    })

    const response = await service.search({ text: 'matched' })

    expect(response.mode).toBe('hybrid')
    expect(response.degradation).toBe('semantic-source-empty')
    expect(response.results).toHaveLength(1)
  })
})
