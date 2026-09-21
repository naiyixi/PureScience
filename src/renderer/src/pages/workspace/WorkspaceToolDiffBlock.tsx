import { useMemo } from 'react'

import { cn } from '@/lib/utils'

import { diffArtifactText, type ArtifactDiffRow } from './artifact-line-diff'
import type { ToolDiffSection } from './workspace-tool-activity-details'

type WorkspaceToolDiffBlockProps = {
  section: ToolDiffSection
}

// Unchanged lines kept around a change. Longer runs collapse, so a one-line edit in a large file still
// reads as a one-line edit instead of two full copies of the file.
const CONTEXT_LINES = 2

export type ToolDiffRow = ArtifactDiffRow | { kind: 'gap'; lines: number }

/**
 * The changed lines with their surrounding context, and a marker for every run that was left out.
 *
 * Pure, so the shape of what the reader sees is testable without a DOM.
 */
export const toolDiffRows = (
  rows: readonly ArtifactDiffRow[],
  context = CONTEXT_LINES
): ToolDiffRow[] => {
  const keep = new Set<number>()
  rows.forEach((row, index) => {
    if (row.kind === 'same') return
    for (let offset = -context; offset <= context; offset += 1) {
      const target = index + offset
      if (target >= 0 && target < rows.length) keep.add(target)
    }
  })

  const visible: ToolDiffRow[] = []
  let skipped = 0
  rows.forEach((row, index) => {
    if (keep.has(index)) {
      if (skipped > 0) {
        visible.push({ kind: 'gap', lines: skipped })
        skipped = 0
      }
      visible.push(row)
      return
    }
    skipped += 1
  })
  if (skipped > 0) visible.push({ kind: 'gap', lines: skipped })
  return visible
}

/**
 * Renders a file edit with the same line diff the artifact version comparison uses.
 *
 * It used to render every old line followed by every new line — a "compact" shape that was not a diff
 * at all: a one-line edit in a long file read as two full copies, and nothing showed which lines moved.
 * Sharing the artifact diff gives the reader real added/removed lines, their line numbers, and a bounded
 * fallback for a change too large to align.
 */
const WorkspaceToolDiffBlock = ({ section }: WorkspaceToolDiffBlockProps): React.JSX.Element => {
  const rows = useMemo(
    () => toolDiffRows(diffArtifactText(section.oldText ?? '', section.newText).rows),
    [section.oldText, section.newText]
  )

  return (
    <pre
      data-testid="tool-diff-block"
      className="max-h-[320px] overflow-auto rounded-md border border-border-200 bg-bg-000 py-2.5 font-mono text-[12px] leading-relaxed"
    >
      <code className="block whitespace-pre">
        {rows.map((row, index) =>
          row.kind === 'gap' ? (
            <span
              key={`gap-${index}`}
              data-kind="gap"
              className="block select-none px-3 text-muted-foreground/70"
            >
              {`… ${row.lines} unchanged ${row.lines === 1 ? 'line' : 'lines'}`}
            </span>
          ) : (
            <span
              key={index}
              data-kind={row.kind}
              data-before-line={row.beforeLine ?? undefined}
              data-after-line={row.afterLine ?? undefined}
              className={cn(
                'block px-3',
                row.kind === 'added' && 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
                row.kind === 'removed' && 'bg-rose-500/10 text-rose-700 dark:text-rose-400'
              )}
            >
              <span aria-hidden="true" className="mr-2 select-none opacity-70">
                {row.kind === 'added' ? '+' : row.kind === 'removed' ? '−' : ' '}
              </span>
              {row.text || ' '}
            </span>
          )
        )}
      </code>
    </pre>
  )
}

export { WorkspaceToolDiffBlock }
