import { describe, expect, it } from 'vitest'
import { fuseKnowledgeHits, knowledgeHitKey } from './knowledge-fusion'
import type { KnowledgeLocator } from './knowledge'

const fileLocator = (path: string, line: number): KnowledgeLocator => ({
  kind: 'file',
  path,
  startLine: line,
  endLine: line + 2
})

const row = (
  sourceId: string,
  path: string,
  line: number,
  extra: { lexicalRank?: number; semanticScore?: number } = {}
): {
  sourceId: string
  label: string
  locator: KnowledgeLocator
  lexicalRank?: number
  semanticScore?: number
} => ({ sourceId, label: `${path}:${line}`, locator: fileLocator(path, line), ...extra })

describe('knowledge fusion', () => {
  it('joins the two lists on the cited span, not on the label', () => {
    const fused = fuseKnowledgeHits(
      [row('src-1', 'a.md', 1, { lexicalRank: 0 })],
      [row('src-1', 'a.md', 1, { semanticScore: 0.9 })]
    )
    expect(fused.hits).toHaveLength(1)
    expect(fused.hits[0].matchedBy).toBe('both')
    expect(fused.counts).toEqual({ lexical: 1, semantic: 0, both: 1 })
  })

  it('keeps a semantic-only row, and says so', () => {
    const fused = fuseKnowledgeHits([], [row('src-1', 'b.md', 5, { semanticScore: 0.42 })])
    expect(fused.hits).toHaveLength(1)
    expect(fused.hits[0].matchedBy).toBe('semantic')
    expect(fused.hits[0].score).toBeCloseTo(0.42)
  })

  it('ranks a row both methods found above either method alone', () => {
    const fused = fuseKnowledgeHits(
      [row('src-1', 'lex.md', 1, { lexicalRank: 0 })],
      [
        row('src-1', 'sem.md', 9, { semanticScore: 0.6 }),
        row('src-1', 'lex.md', 1, { semanticScore: 0.6 })
      ]
    )
    expect(fused.hits[0].locator).toMatchObject({ path: 'lex.md' })
    expect(fused.hits[0].matchedBy).toBe('both')
    expect(fused.hits[1].matchedBy).toBe('semantic')
  })

  it('scores lexical rank without a clock: rank 0 beats rank 1 deterministically', () => {
    const fused = fuseKnowledgeHits(
      [row('s', 'first.md', 1, { lexicalRank: 0 }), row('s', 'second.md', 1, { lexicalRank: 1 })],
      []
    )
    expect(fused.hits.map((hit) => hit.locator)).toEqual([
      fileLocator('first.md', 1),
      fileLocator('second.md', 1)
    ])
    expect(fused.hits[0].score).toBe(1)
    expect(fused.hits[1].score).toBe(0.5)
    expect(fused.recipe).toEqual({
      lexicalWeight: 1,
      semanticWeight: 1,
      lexicalScore: 'inverse-rank'
    })
  })

  it('breaks equal scores on the citation key so the answer never depends on insertion order', () => {
    const left = fuseKnowledgeHits(
      [row('s', 'b.md', 1, { lexicalRank: 0 }), row('s', 'a.md', 1, { lexicalRank: 0 })],
      []
    )
    const right = fuseKnowledgeHits(
      [row('s', 'a.md', 1, { lexicalRank: 0 }), row('s', 'b.md', 1, { lexicalRank: 0 })],
      []
    )
    expect(left.hits.map((hit) => hit.locator)).toEqual(right.hits.map((hit) => hit.locator))
    expect(left.hits.map((hit) => hit.locator)).toEqual([
      fileLocator('a.md', 1),
      fileLocator('b.md', 1)
    ])
  })

  it('applies the limit after ranking, and reports counts before it', () => {
    const fused = fuseKnowledgeHits(
      [row('s', 'a.md', 1, { lexicalRank: 0 }), row('s', 'b.md', 1, { lexicalRank: 1 })],
      [],
      { limit: 1 }
    )
    expect(fused.hits).toHaveLength(1)
    expect(fused.counts.lexical).toBe(2)
  })

  it('keys a url and a page span apart from a file span', () => {
    expect(knowledgeHitKey('s', { kind: 'url', url: 'https://example.org' })).toBe(
      's|url:https://example.org'
    )
    expect(knowledgeHitKey('s', { kind: 'pdf', path: 'p.pdf', page: 3 })).toBe('s|pdf:p.pdf:3')
    expect(knowledgeHitKey('s', fileLocator('a.md', 1))).toBe('s|file:a.md:1')
  })
})
