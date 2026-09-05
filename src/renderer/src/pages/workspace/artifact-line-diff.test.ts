import { describe, expect, it } from 'vitest'

import { diffArtifactText } from './artifact-line-diff'

describe('artifact-line-diff', () => {
  it('returns only same rows for identical content', () => {
    const result = diffArtifactText('alpha\nbeta\ngamma\n', 'alpha\nbeta\ngamma\n')
    expect(result.rows).toEqual([
      { kind: 'same', text: 'alpha', beforeLine: 1, afterLine: 1 },
      { kind: 'same', text: 'beta', beforeLine: 2, afterLine: 2 },
      { kind: 'same', text: 'gamma', beforeLine: 3, afterLine: 3 }
    ])
    expect(result.additions).toBe(0)
    expect(result.deletions).toBe(0)
    expect(result.coarse).toBe(false)
  })

  it('diffs a pure insertion at the end', () => {
    const result = diffArtifactText('alpha\nbeta', 'alpha\nbeta\ngamma')
    expect(result.rows).toEqual([
      { kind: 'same', text: 'alpha', beforeLine: 1, afterLine: 1 },
      { kind: 'same', text: 'beta', beforeLine: 2, afterLine: 2 },
      { kind: 'added', text: 'gamma', afterLine: 3 }
    ])
    expect(result.additions).toBe(1)
    expect(result.deletions).toBe(0)
  })

  it('diffs a pure deletion at the start', () => {
    const result = diffArtifactText('alpha\nbeta', 'beta')
    expect(result.rows).toEqual([
      { kind: 'removed', text: 'alpha', beforeLine: 1 },
      { kind: 'same', text: 'beta', beforeLine: 2, afterLine: 1 }
    ])
    expect(result.additions).toBe(0)
    expect(result.deletions).toBe(1)
  })

  it('aligns a middle replacement with unchanged surroundings', () => {
    const result = diffArtifactText('a\nb\nc\nd', 'a\nB\nC\nd')
    const kinds = result.rows.map((row) => row.kind)
    expect(kinds[0]).toBe('same')
    expect(kinds).toContain('removed')
    expect(kinds).toContain('added')
    expect(kinds.at(-1)).toBe('same')
    // The unchanged tail stays anchored to its true line numbers.
    expect(result.rows.at(-1)).toEqual({ kind: 'same', text: 'd', beforeLine: 4, afterLine: 4 })
    expect(result.additions).toBe(2)
    expect(result.deletions).toBe(2)
  })

  it('handles empty before/after content', () => {
    const empty = diffArtifactText('', '')
    expect(empty.rows).toEqual([])

    const created = diffArtifactText('', 'x\ny')
    expect(created.rows.map((row) => row.kind)).toEqual(['added', 'added'])
    expect(created.rows[1]).toEqual({ kind: 'added', text: 'y', afterLine: 2 })
    expect(created.additions).toBe(2)

    const deleted = diffArtifactText('x\ny', '')
    expect(deleted.rows.map((row) => row.kind)).toEqual(['removed', 'removed'])
    expect(deleted.deletions).toBe(2)
  })

  it('treats a trailing newline as insignificant', () => {
    const withNewline = diffArtifactText('a\nb\n', 'a\nb')
    expect(withNewline.rows).toEqual([
      { kind: 'same', text: 'a', beforeLine: 1, afterLine: 1 },
      { kind: 'same', text: 'b', beforeLine: 2, afterLine: 2 }
    ])
    expect(withNewline.additions + withNewline.deletions).toBe(0)
  })

  it('preserves interior empty lines', () => {
    const result = diffArtifactText('a\n\nc', 'a\nx\nc')
    expect(result.rows).toEqual([
      { kind: 'same', text: 'a', beforeLine: 1, afterLine: 1 },
      { kind: 'removed', text: '', beforeLine: 2 },
      { kind: 'added', text: 'x', afterLine: 2 },
      { kind: 'same', text: 'c', beforeLine: 3, afterLine: 3 }
    ])
  })

  it('degrades to a coarse replace region beyond the LCS bound', () => {
    const before = Array.from({ length: 4000 }, (_, index) => `before-${index}`).join('\n')
    const after = Array.from({ length: 4000 }, (_, index) => `after-${index}`).join('\n')
    const result = diffArtifactText(before, after)
    expect(result.coarse).toBe(true)
    expect(result.deletions).toBe(4000)
    expect(result.additions).toBe(4000)
    expect(result.rows).toHaveLength(8000)
    // The whole middle renders as one replace region: all removals precede all additions.
    expect(result.rows[0].kind).toBe('removed')
    expect(result.rows[3999].kind).toBe('removed')
    expect(result.rows[4000].kind).toBe('added')
    expect(result.rows.at(-1)?.kind).toBe('added')
  })
})
