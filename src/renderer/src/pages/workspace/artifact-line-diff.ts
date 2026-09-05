// Line-level diff for artifact text version comparison. Self-contained (no runtime dependency):
// strips the common head/tail, then runs a bounded LCS over the differing middle. Content too large
// for the DP table degrades to one coarse replace region instead of freezing the UI.

export type ArtifactDiffLineKind = 'same' | 'added' | 'removed'

export type ArtifactDiffRow = {
  kind: ArtifactDiffLineKind
  text: string
  // 1-based line numbers; present only when the row exists on that side.
  beforeLine?: number
  afterLine?: number
}

export type ArtifactLineDiff = {
  rows: ArtifactDiffRow[]
  additions: number
  deletions: number
  // True when the differing middle exceeded the LCS bound and was rendered as one replace region.
  coarse: boolean
}

// Memory guard for the LCS table: (n+1)*(m+1) Uint32 cells over the differing middle.
const MAX_LCS_CELLS = 6_000_000

// A trailing newline does not create an extra empty line; interior empty lines are preserved.
const splitLines = (text: string): string[] => {
  if (text === '') return []
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

export const diffArtifactText = (before: string, after: string): ArtifactLineDiff => {
  const beforeLines = splitLines(before)
  const afterLines = splitLines(after)

  // Common head/tail never needs the DP table and keeps identical files trivially cheap.
  let head = 0
  while (
    head < beforeLines.length &&
    head < afterLines.length &&
    beforeLines[head] === afterLines[head]
  ) {
    head += 1
  }
  let tail = 0
  while (
    tail < beforeLines.length - head &&
    tail < afterLines.length - head &&
    beforeLines[beforeLines.length - 1 - tail] === afterLines[afterLines.length - 1 - tail]
  ) {
    tail += 1
  }

  const beforeMid = beforeLines.slice(head, beforeLines.length - tail)
  const afterMid = afterLines.slice(head, afterLines.length - tail)
  const rows: ArtifactDiffRow[] = []
  let additions = 0
  let deletions = 0
  let coarse = false

  for (let index = 0; index < head; index += 1) {
    rows.push({
      kind: 'same',
      text: beforeLines[index],
      beforeLine: index + 1,
      afterLine: index + 1
    })
  }

  const emitCore = (
    core: Array<{
      kind: ArtifactDiffLineKind
      text: string
      beforeLine?: number
      afterLine?: number
    }>
  ): void => {
    for (const row of core) {
      if (row.kind === 'added') additions += 1
      if (row.kind === 'removed') deletions += 1
      rows.push(row)
    }
  }

  if (beforeMid.length === 0) {
    emitCore(
      afterMid.map((text, index) => ({
        kind: 'added' as const,
        text,
        afterLine: head + index + 1
      }))
    )
  } else if (afterMid.length === 0) {
    emitCore(
      beforeMid.map((text, index) => ({
        kind: 'removed' as const,
        text,
        beforeLine: head + index + 1
      }))
    )
  } else if (beforeMid.length * afterMid.length > MAX_LCS_CELLS) {
    // Coarse replace region: no granular alignment, but both sides stay visible and counted.
    coarse = true
    emitCore(
      beforeMid.map((text, index) => ({
        kind: 'removed' as const,
        text,
        beforeLine: head + index + 1
      }))
    )
    emitCore(
      afterMid.map((text, index) => ({
        kind: 'added' as const,
        text,
        afterLine: head + index + 1
      }))
    )
  } else {
    emitCore(diffMiddle(beforeMid, afterMid, head))
  }

  const beforeTailStart = beforeLines.length - tail
  for (let index = 0; index < tail; index += 1) {
    const line = beforeLines[beforeTailStart + index]
    rows.push({
      kind: 'same',
      text: line,
      beforeLine: beforeTailStart + index + 1,
      afterLine: afterLines.length - tail + index + 1
    })
  }

  return { rows, additions, deletions, coarse }
}

// Unified diff rows for the differing middle via LCS backtracking. Line numbers are 1-based in the
// original files (headOffset = number of stripped common head lines).
const diffMiddle = (
  beforeMid: string[],
  afterMid: string[],
  headOffset: number
): ArtifactDiffRow[] => {
  const n = beforeMid.length
  const m = afterMid.length
  const width = m + 1
  const table = new Uint32Array((n + 1) * width)

  for (let i = 1; i <= n; i += 1) {
    const rowStart = i * width
    const previousRowStart = (i - 1) * width
    const beforeLine = beforeMid[i - 1]
    for (let j = 1; j <= m; j += 1) {
      if (beforeLine === afterMid[j - 1]) {
        table[rowStart + j] = table[previousRowStart + j - 1] + 1
      } else {
        const left = table[rowStart + j - 1]
        const up = table[previousRowStart + j]
        table[rowStart + j] = left >= up ? left : up
      }
    }
  }

  // Walk back from (n, m): an equal pair is kept; otherwise the side whose suffix can still reach
  // the longer LCS is emitted first (ties prefer an insertion so deletions land before additions).
  const reversed: ArtifactDiffRow[] = []
  let i = n
  let j = m
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && beforeMid[i - 1] === afterMid[j - 1]) {
      reversed.push({
        kind: 'same',
        text: beforeMid[i - 1],
        beforeLine: headOffset + i,
        afterLine: headOffset + j
      })
      i -= 1
      j -= 1
    } else if (j > 0 && (i === 0 || table[i * width + (j - 1)] >= table[(i - 1) * width + j])) {
      reversed.push({ kind: 'added', text: afterMid[j - 1], afterLine: headOffset + j })
      j -= 1
    } else {
      reversed.push({ kind: 'removed', text: beforeMid[i - 1], beforeLine: headOffset + i })
      i -= 1
    }
  }

  reversed.reverse()
  return reversed
}
