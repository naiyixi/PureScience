import { describe, expect, it } from 'vitest'

import { diffArtifactText } from './artifact-line-diff'
import { toolDiffRows } from './WorkspaceToolDiffBlock'

// What the reader actually sees for a file edit. The block used to print every old line followed by
// every new line, so these cases are about the shared line diff being real: a one-line edit reads as a
// one-line edit, an insertion does not restyle everything after it, and long runs of unchanged lines
// collapse instead of being copied twice.
describe('toolDiffRows', () => {
  const rowsFor = (
    before: string,
    after: string,
    context?: number
  ): ReturnType<typeof toolDiffRows> => toolDiffRows(diffArtifactText(before, after).rows, context)

  it('shows a changed line with its surrounding context, and folds the rest', () => {
    const before = ['one', 'two', 'three', 'four', 'five', 'six', 'seven'].join('\n')
    const after = ['one', 'two', 'THREE', 'four', 'five', 'six', 'seven'].join('\n')

    const rows = rowsFor(before, after)

    // Context either side of the change, then a folded run — not the whole file twice.
    expect(rows.map((row) => row.kind)).toEqual([
      'same',
      'same',
      'removed',
      'added',
      'same',
      'same',
      'gap'
    ])
    const removed = rows.find((row) => row.kind === 'removed')
    const added = rows.find((row) => row.kind === 'added')
    expect(removed).toMatchObject({ text: 'three', beforeLine: 3 })
    expect(added).toMatchObject({ text: 'THREE', afterLine: 3 })
    // 'six' and 'seven' are the run beyond the context window.
    expect(rows.at(-1)).toMatchObject({ kind: 'gap', lines: 2 })
  })

  it('keeps an insertion from restyling everything after it', () => {
    const before = ['alpha', 'beta', 'gamma'].join('\n')
    const after = ['alpha', 'BETA', 'beta', 'gamma'].join('\n')

    const rows = rowsFor(before, after, 0)

    // The old shape marked both of the following lines as new; the shared diff marks one insertion.
    expect(rows.filter((row) => row.kind === 'added')).toHaveLength(1)
    expect(rows.filter((row) => row.kind === 'removed')).toHaveLength(0)
    expect(rows.find((row) => row.kind === 'added')).toMatchObject({ text: 'BETA', afterLine: 2 })
  })

  it('treats a new file as one added region', () => {
    const rows = rowsFor('', 'first\nsecond')

    expect(rows.map((row) => row.kind)).toEqual(['added', 'added'])
    expect(rows.map((row) => (row.kind === 'added' ? row.afterLine : undefined))).toEqual([1, 2])
  })

  it('says nothing changed without pretending the lines were rewritten', () => {
    const rows = rowsFor('same\ntext', 'same\ntext')

    expect(rows).toEqual([{ kind: 'gap', lines: 2 }])
  })
})
