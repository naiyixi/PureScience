import { useMemo } from 'react'

import { diffArtifactText } from './artifact-line-diff'
import { LineDiffView, foldDiffRows, type LineDiffRow } from './LineDiffView'
import type { ToolDiffSection } from './workspace-tool-activity-details'

type WorkspaceToolDiffBlockProps = {
  section: ToolDiffSection
}

// Unchanged lines kept around a change. Longer runs collapse, so a one-line edit in a large file still
// reads as a one-line edit instead of two full copies of the file.
const CONTEXT_LINES = 2

/** Kept as the block's own name for the shared folding; the viewer owns the behaviour. */
export const toolDiffRows = (
  rows: Parameters<typeof foldDiffRows>[0],
  context = CONTEXT_LINES
): LineDiffRow[] => foldDiffRows(rows, context)

/**
 * Renders a file edit with the same diff viewer the artifact version comparison uses.
 *
 * It used to render every old line followed by every new line — a "compact" shape that was not a diff
 * at all: a one-line edit in a long file read as two full copies, and nothing showed which lines moved.
 */
const WorkspaceToolDiffBlock = ({ section }: WorkspaceToolDiffBlockProps): React.JSX.Element => {
  const rows = useMemo(
    () => diffArtifactText(section.oldText ?? '', section.newText).rows,
    [section.oldText, section.newText]
  )

  return (
    <LineDiffView
      as="pre"
      rows={rows}
      context={CONTEXT_LINES}
      testId="tool-diff-block"
      className="max-h-[320px] overflow-auto rounded-md border border-border-200 bg-bg-000 py-2.5 text-[12px] leading-relaxed"
    />
  )
}

export { WorkspaceToolDiffBlock }
