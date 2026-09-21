import { cn } from '@/lib/utils'

import { foldDiffRows, type ArtifactDiffRow, type LineDiffRow } from './artifact-line-diff'

// One diff viewer for the two places that show a file edit: the artifact version comparison and the tool
// activity block. They had grown separate renderings of the same rows — one of them not a diff at all —
// so the line shape, the line numbers, the fold marker and the colours live here and nowhere else.

const rowBackground = (kind: ArtifactDiffRow['kind']): string => {
  if (kind === 'added') {
    return 'bg-emerald-500/10 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
  }
  if (kind === 'removed') return 'bg-red-500/10 text-red-700 dark:bg-red-950/40 dark:text-red-300'
  return 'text-text-100'
}

const rowNumberColor = (kind: ArtifactDiffRow['kind']): string => {
  if (kind === 'added') return 'text-emerald-700 dark:text-emerald-300'
  if (kind === 'removed') return 'text-red-700 dark:text-red-300'
  return 'text-text-300'
}

const rowSign = (kind: ArtifactDiffRow['kind']): string =>
  kind === 'added' ? '+' : kind === 'removed' ? '−' : ''

const gapLabel = (lines: number): string => `… ${lines} unchanged ${lines === 1 ? 'line' : 'lines'}`

export type LineDiffViewProps = {
  rows: readonly ArtifactDiffRow[]
  testId?: string
  className?: string
  /** Unchanged lines kept either side of a change; rows are shown whole when folding is off. */
  folded?: boolean
  context?: number
  as?: 'div' | 'pre'
}

export const LineDiffView = ({
  rows,
  testId,
  className,
  folded = true,
  context = 2,
  as = 'div'
}: LineDiffViewProps): React.JSX.Element => {
  const visible: readonly LineDiffRow[] = folded ? foldDiffRows(rows, context) : rows
  const Container = as

  return (
    <Container data-testid={testId} className={cn('font-mono', className)}>
      {visible.map((row, index) =>
        row.kind === 'gap' ? (
          <div
            key={`gap-${index}`}
            data-kind="gap"
            className="flex select-none whitespace-pre px-2 text-text-300"
          >
            <span className="w-7 shrink-0" />
            <span className="w-4 shrink-0 text-center">⋯</span>
            <span className="min-w-0 flex-1">{gapLabel(row.lines)}</span>
          </div>
        ) : (
          <div
            key={index}
            data-kind={row.kind}
            className={cn('flex whitespace-pre px-2', rowBackground(row.kind))}
          >
            <span className={cn('w-7 shrink-0 select-none text-right', rowNumberColor(row.kind))}>
              {row.kind === 'added' ? row.afterLine : row.beforeLine}
            </span>
            <span className="w-4 shrink-0 select-none text-center">{rowSign(row.kind)}</span>
            <span className="min-w-0 flex-1">{row.text === '' ? ' ' : row.text}</span>
          </div>
        )
      )}
    </Container>
  )
}
