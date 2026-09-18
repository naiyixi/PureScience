import { describe, expect, it } from 'vitest'

import { deriveProjectFileKinds, PROJECT_FILE_KIND_LIMIT } from './project-file-kinds'

// The chips are the only visible output of this rule, and main will soon derive kinds for many projects in one
// round-trip, so the semantics are pinned here: newest first, uppercased extension, at most four, and nothing
// that is not a 1-5 character alphanumeric extension.
describe('deriveProjectFileKinds', () => {
  it('takes kinds newest-first and uppercases the extension', () => {
    expect(
      deriveProjectFileKinds([
        { name: 'old.md', sortAtMs: 1 },
        { name: 'new.png', sortAtMs: 5 }
      ])
    ).toEqual(['PNG', 'MD'])
  })

  it('deduplicates and stops at the limit', () => {
    expect(
      deriveProjectFileKinds([
        { name: 'a.pdf', sortAtMs: 6 },
        { name: 'b.csv', sortAtMs: 5 },
        { name: 'c.pdf', sortAtMs: 4 },
        { name: 'd.json', sortAtMs: 3 },
        { name: 'e.html', sortAtMs: 2 },
        { name: 'f.npz', sortAtMs: 1 }
      ])
    ).toEqual(['PDF', 'CSV', 'JSON', 'HTML'])
    expect(deriveProjectFileKinds([{ name: 'a.pdf', sortAtMs: 1 }])).toHaveLength(1)
    expect(PROJECT_FILE_KIND_LIMIT).toBe(4)
  })

  it('ignores names with no usable extension', () => {
    expect(
      deriveProjectFileKinds([
        { name: 'no-extension', sortAtMs: 4 },
        { name: 'trailing.', sortAtMs: 3 },
        { name: '.hidden', sortAtMs: 2 },
        { name: 'too-long.abcdefg', sortAtMs: 1 }
      ])
    ).toEqual([])
  })
})
