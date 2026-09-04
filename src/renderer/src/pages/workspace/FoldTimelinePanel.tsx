// FoldTimelinePanel: the session's folded-context timeline. Each entry is an immutable chunk
// persisted when the agent's context was compacted — the transcript window that was folded away.
// The agent can still retrieve exact details via summary_query; this panel lets the USER see what
// was folded, when, why, and with which boundary label, and expand the chunk summary.

import { useEffect, useState } from 'react'
import { ChevronRight, FoldHorizontal } from 'lucide-react'
import { useLanguage } from '@/i18n'
import { getUiLocale } from '@/lib/ui-locale'
import { cn } from '@/lib/utils'

import type { ContextSummaryChunkView } from '../../../../shared/reviewer'

type FoldTimelinePanelProps = {
  projectId: string
  sessionId: string
}

const REASON_KEY: Record<string, string> = {
  automatic: 'foldTimeline.reasonAutomatic',
  manual: 'foldTimeline.reasonManual',
  'overflow-recovery': 'foldTimeline.reasonOverflow'
}

const ChunkRow = ({ chunk }: { chunk: ContextSummaryChunkView }): React.JSX.Element => {
  const { t } = useLanguage()
  const [expanded, setExpanded] = useState(false)
  const reasonKey = REASON_KEY[chunk.reason]
  const reason = reasonKey ? (t as (key: string) => string)(reasonKey) : chunk.reason
  const when = new Date(chunk.foldedAt).toLocaleString(getUiLocale())

  return (
    <div
      className="rounded-lg border border-border-200 bg-bg-000 p-3"
      data-testid="fold-chunk"
      data-chunk-id={chunk.id}
    >
      <button
        type="button"
        className="flex w-full items-start gap-2 text-left"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        data-testid="fold-chunk-toggle"
      >
        <FoldHorizontal className="mt-0.5 h-3.5 w-3.5 shrink-0 text-text-400" aria-hidden />
        <div className="flex-1">
          <p className="text-xs font-medium leading-snug text-text-000">
            {chunk.id}
            {chunk.level === 2 && (
              <span className="ml-1.5 rounded bg-bg-200 px-1 py-0.5 text-[10px] font-semibold uppercase text-text-400">
                level 2
              </span>
            )}
          </p>
          <p className="mt-0.5 text-[11px] text-text-400">
            {reason} &middot; {when}
            {chunk.boundaryLabel ? ` · “${chunk.boundaryLabel}”` : ''}
            {chunk.foldedTokens !== undefined ? ` · ~${chunk.foldedTokens} tokens` : ''}
          </p>
        </div>
        <ChevronRight
          className={cn(
            'h-3.5 w-3.5 shrink-0 text-text-400 transition-transform',
            expanded && 'rotate-90'
          )}
          aria-hidden
        />
      </button>

      {expanded && (
        <div
          className="mt-2 space-y-2 border-t border-border-200 pt-2"
          data-testid="fold-chunk-body"
        >
          <p className="text-xs leading-relaxed text-text-300">{chunk.summaryText}</p>
          {chunk.transcriptPreview && (
            <details className="text-[11px]">
              <summary className="cursor-pointer font-medium text-text-400 hover:text-text-300">
                {t('foldTimeline.previewSummary')}
              </summary>
              <pre className="mt-1.5 max-h-48 overflow-y-auto whitespace-pre-wrap rounded bg-bg-200/50 p-2 text-[11px] leading-relaxed text-text-300">
                {chunk.transcriptPreview}
                {chunk.transcriptPreview.length >= 500 ? '\n…' : ''}
              </pre>
            </details>
          )}
        </div>
      )}
    </div>
  )
}

const FoldTimelinePanel = ({ projectId, sessionId }: FoldTimelinePanelProps): React.JSX.Element => {
  const { t } = useLanguage()
  const [chunks, setChunks] = useState<ContextSummaryChunkView[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      setLoading(true)
      try {
        const loaded = await window.api.reviewer.getChunks({ projectId, appSessionId: sessionId })
        if (!cancelled) setChunks(loaded)
      } catch {
        if (!cancelled) setChunks([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [projectId, sessionId])

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <div className="shrink-0 border-b border-border-200 px-4 py-3">
        <h2 className="text-[13px] font-semibold text-text-000">{t('foldTimeline.title')}</h2>
        <p className="mt-0.5 text-[11px] text-text-300">
          {t('foldTimeline.foldCount')
            .replace('{n}', String(chunks.length))
            .replace('{s}', chunks.length === 1 ? '' : 's')
            .replace('{tool}', 'summary_query')}
        </p>
      </div>

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto px-4 py-3">
        {loading ? (
          <p className="text-xs text-text-400" data-testid="fold-timeline-loading">
            Loading…
          </p>
        ) : chunks.length === 0 ? (
          <p className="text-xs text-text-400" data-testid="fold-timeline-empty">
            No context folds yet. When the agent&apos;s context is compacted, the folded window is
            kept here and remains queryable.
          </p>
        ) : (
          <div className="space-y-2">
            {chunks.map((chunk) => (
              <ChunkRow key={chunk.id} chunk={chunk} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export { FoldTimelinePanel }
