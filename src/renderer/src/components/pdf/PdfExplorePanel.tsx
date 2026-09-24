import { useEffect, useState } from 'react'

import { useLanguage } from '@/i18n'
import { Button } from '@/components/ui/button'
import type { PdfFigureForAgent, PdfOutlineEntry } from '../../../../shared/pdf'

// The document's own structure, from the reader the agent already uses (`pdf.outline` + `pdf.figures`):
// the bookmark tree as the document declares it, and every placement the extractor accepted as a figure,
// per page. Both channels have existed since the PDF work landed and neither had a surface, so a reader
// could not see that a paper has a table of contents at all, nor which pages carry figures before quoting
// one.
//
// What this panel must never do, for the same reason `PdfTablePanel` says how far it looked:
//   - report "no outline" as if the document had none when what it means is that it declares no bookmarks;
//   - present the figure list as the document's figure inventory while the extractor is dropping small
//     placements and the document leaves figures uncaptioned — both are counted and named, not swallowed;
//   - invent a jump target. There is no page-viewer surface here, so an outline row is structural
//     information, not a control that quietly does nothing.

type PdfExplorePanelProps = {
  projectId: string
  sourcePath: string
  /** The Session the file came from: without it an Artifact Version locator cannot be resolved. */
  sourceSessionId?: string
  onClose: () => void
}

type OutlineState =
  | { status: 'loading' }
  | { status: 'ready'; entries: PdfOutlineEntry[]; pageCount: number; title: string }
  | { status: 'failed'; message: string }

type FiguresState =
  | { status: 'loading' }
  | {
      status: 'ready'
      figures: PdfFigureForAgent[]
      scannedPages: number
      skippedSmall: number
      withoutCaption: number
    }
  | { status: 'failed'; message: string }

const PdfExplorePanel = ({
  projectId,
  sourcePath,
  sourceSessionId,
  onClose
}: PdfExplorePanelProps): React.JSX.Element => {
  const { t } = useLanguage()
  const [outline, setOutline] = useState<OutlineState>({ status: 'loading' })
  const [figures, setFigures] = useState<FiguresState>({ status: 'loading' })

  useEffect(() => {
    let active = true
    const load = async (): Promise<void> => {
      const pdf = window.api?.pdf
      if (typeof pdf?.open !== 'function' || typeof pdf?.outline !== 'function') {
        const message = t('pdf.explore.unavailable')
        setOutline({ status: 'failed', message })
        setFigures({ status: 'failed', message })
        return
      }
      try {
        const opened = await pdf.open({
          projectId,
          path: sourcePath,
          ...(sourceSessionId ? { sessionId: sourceSessionId } : {})
        })
        const docId = opened.doc.docId
        const [outlineResult, figuresResult] = await Promise.all([
          pdf.outline({ projectId, docId }),
          typeof pdf.figures === 'function' ? pdf.figures({ projectId, docId }) : undefined
        ])
        if (!active) return
        setOutline({
          status: 'ready',
          entries: outlineResult.outline,
          pageCount: outlineResult.pageCount,
          title: outlineResult.title
        })
        setFigures(
          figuresResult
            ? {
                status: 'ready',
                figures: figuresResult.figures,
                scannedPages: figuresResult.scannedPages,
                skippedSmall: figuresResult.skippedSmall,
                withoutCaption: figuresResult.withoutCaption
              }
            : { status: 'failed', message: t('pdf.explore.unavailable') }
        )
      } catch (error) {
        if (!active) return
        const message = error instanceof Error ? error.message : t('pdf.explore.unavailable')
        setOutline({ status: 'failed', message })
        setFigures({ status: 'failed', message })
      }
    }
    void load()
    return () => {
      active = false
    }
  }, [projectId, sourcePath, sourceSessionId, t])

  const pagesByNumber = new Map<number, PdfFigureForAgent[]>()
  if (figures.status === 'ready') {
    for (const figure of figures.figures) {
      const bucket = pagesByNumber.get(figure.page)
      if (bucket) bucket.push(figure)
      else pagesByNumber.set(figure.page, [figure])
    }
  }

  return (
    <div
      data-testid="pdf-explore-panel"
      className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border-300"
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-border-300 px-3 py-2">
        <span className="text-sm font-medium">{t('pdf.explore.title')}</span>
        {outline.status === 'ready' ? (
          <span className="truncate text-xs text-text-300" title={outline.title}>
            {outline.title}
          </span>
        ) : null}
        <span className="flex-1" />
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={onClose}
          aria-label={t('common.close')}
        >
          ×
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-3 py-2">
        <section aria-labelledby="pdf-explore-outline-heading">
          <h3
            id="pdf-explore-outline-heading"
            className="text-xs font-medium uppercase text-text-300"
          >
            {t('pdf.explore.outlineHeading')}
          </h3>
          {outline.status === 'loading' ? (
            <p className="py-1 text-xs text-text-300" data-testid="pdf-explore-outline-loading">
              {t('common.loading')}
            </p>
          ) : outline.status === 'failed' ? (
            <p className="py-1 text-xs text-text-300" data-testid="pdf-explore-outline-failed">
              {outline.message}
            </p>
          ) : outline.entries.length === 0 ? (
            <p className="py-1 text-xs text-text-300" data-testid="pdf-explore-outline-empty">
              {t('pdf.explore.outlineEmpty')}
            </p>
          ) : (
            <>
              <ul data-testid="pdf-explore-outline" className="flex flex-col">
                {outline.entries.map((entry, index) => (
                  <li
                    key={`${entry.page}-${entry.level}-${index}`}
                    data-testid={`pdf-explore-outline-${index}`}
                    className="flex items-baseline gap-2 py-0.5 text-xs"
                    style={{ paddingInlineStart: `${Math.max(entry.level - 1, 0) * 12}px` }}
                  >
                    <span className="min-w-0 flex-1 break-words">{entry.title}</span>
                    <span
                      className="shrink-0 text-text-400"
                      data-testid={`pdf-explore-outline-page-${index}`}
                    >
                      {t('pdf.explore.figurePage', { page: entry.page })}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="py-1 text-[11px] text-text-400">{t('pdf.explore.outlineHint')}</p>
            </>
          )}
        </section>

        <section aria-labelledby="pdf-explore-figures-heading" className="mt-3">
          <h3
            id="pdf-explore-figures-heading"
            className="text-xs font-medium uppercase text-text-300"
          >
            {t('pdf.explore.figuresHeading')}
          </h3>
          {figures.status === 'loading' ? (
            <p className="py-1 text-xs text-text-300" data-testid="pdf-explore-figures-loading">
              {t('common.loading')}
            </p>
          ) : figures.status === 'failed' ? (
            <p className="py-1 text-xs text-text-300" data-testid="pdf-explore-figures-failed">
              {figures.message}
            </p>
          ) : (
            <>
              <p className="py-1 text-xs text-text-300" data-testid="pdf-explore-figures-scan">
                {t('pdf.explore.figuresScanned', { pages: figures.scannedPages })}
              </p>
              {figures.figures.length === 0 ? (
                <p className="py-1 text-xs text-text-300" data-testid="pdf-explore-figures-empty">
                  {t('pdf.explore.figuresEmpty', { pages: figures.scannedPages })}
                </p>
              ) : (
                [...pagesByNumber.entries()].map(([page, pageFigures]) => (
                  <div key={page} data-testid={`pdf-explore-figure-page-${page}`} className="mt-1">
                    <p className="text-xs text-text-300">{t('pdf.explore.figurePage', { page })}</p>
                    <ul className="flex flex-col">
                      {pageFigures.map((figure) => (
                        <li
                          key={`${figure.page}-${figure.index}`}
                          data-testid={`pdf-explore-figure-${figure.page}-${figure.index}`}
                          className="flex flex-col py-0.5 text-xs"
                        >
                          <span className="text-text-200">
                            {`#${figure.index} · ${Math.round(figure.bbox.width)}x${Math.round(figure.bbox.height)}`}
                          </span>
                          {figure.caption ? (
                            <span className="break-words text-text-300">{figure.caption}</span>
                          ) : (
                            <span className="text-text-400">
                              {t('pdf.explore.figureCaptionNone')}
                            </span>
                          )}
                          {figure.warnings.length > 0 ? (
                            <span className="text-text-400">
                              {t('pdf.explore.warningsHeading')}
                              {': '}
                              {figure.warnings.join(' · ')}
                            </span>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))
              )}
              {figures.skippedSmall > 0 ? (
                <p
                  className="py-1 text-[11px] text-text-400"
                  data-testid="pdf-explore-figures-skipped"
                >
                  {t('pdf.explore.figuresSkipped', { count: figures.skippedSmall })}
                </p>
              ) : null}
              {figures.withoutCaption > 0 ? (
                <p
                  className="py-1 text-[11px] text-text-400"
                  data-testid="pdf-explore-figures-uncaptioned"
                >
                  {t('pdf.explore.figuresWithoutCaption', { count: figures.withoutCaption })}
                </p>
              ) : null}
            </>
          )}
        </section>
      </div>
    </div>
  )
}

export { PdfExplorePanel }
