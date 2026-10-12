// A 线的阅读面板：三种模式、逐页状态、逐段术语偏离、点译文回跳原文。
//
// 这一层是**受控组件**：行、状态、偏离、模式都由父层给（数据来自哪条通道由接线那一层决定），
// 于是它在接线落定之前就能被完整地渲染与断言 —— 面板的措辞、对齐与回跳都不依赖通道。
//
// 三条它自己负责的呈现规矩：
//  1. **未译/失败/保留各说各的**，不合成一句「没有译文」：三种状态的下一步动作完全不同。
//  2. **没文本层的页要说出「没有文本层」**（A6）：它和「还没翻」在屏上必须一眼分得开。
//  3. **点译文回跳**（A3）：点译文格子把**同一行**的原文格子标出来（行号来自共享的阅读层，
//     面板不自己找「近似的那一段」）。

import { useCallback, useMemo, useState } from 'react'

import { Button } from '@/components/ui/button'
import { useLanguage, type TranslationKey } from '@/i18n'
import { cn } from '@/lib/utils'
import type { TerminologyDeviation } from '../../../../../../shared/translation-terminology'
import type {
  TranslationPageStatus,
  TranslationPageStatusKind
} from '../../../../../../shared/translation-page-status'
import {
  TRANSLATION_READING_COLUMNS,
  TRANSLATION_READING_MODES,
  type ReadingRow,
  type TranslationReadingMode
} from '../../../../../../shared/translation-reading'

/** 逐页状态的文案键写成字面量联合：`t()` 只认字面量键，拼出来的字符串过不了类型检查。 */
const PAGE_STATUS_KEYS: Record<TranslationPageStatusKind, TranslationKey> = {
  'no-text-layer': 'translation.page.noTextLayer',
  untranslated: 'translation.page.untranslated',
  partial: 'translation.page.partial',
  translated: 'translation.page.translated',
  failed: 'translation.page.failed'
}

const MODE_KEYS: Record<TranslationReadingMode, TranslationKey> = {
  source: 'translation.mode.source',
  translated: 'translation.mode.translated',
  contrast: 'translation.mode.contrast'
}

export type TranslationPanelProps = {
  rows: readonly ReadingRow[]
  pageStatuses?: readonly TranslationPageStatus[]
  /** A4：逐段具名的术语偏离（段 id → 偏离项）。 */
  terminologyDeviations?: readonly TerminologyDeviation[]
  mode: TranslationReadingMode
  onModeChange: (mode: TranslationReadingMode) => void
  /** A7：导出对照件。没接上就不显示这个按钮（不做一个点了没反应的控件）。 */
  onExportContrast?: () => void
  exportNote?: string
}

export const TranslationPanel = ({
  rows,
  pageStatuses = [],
  terminologyDeviations = [],
  mode,
  onModeChange,
  onExportContrast,
  exportNote
}: TranslationPanelProps): React.JSX.Element => {
  const { t } = useLanguage()
  const [highlightedRow, setHighlightedRow] = useState<number | undefined>(undefined)

  const deviationsByUnit = useMemo(() => {
    const byUnit = new Map<string, TerminologyDeviation[]>()
    for (const deviation of terminologyDeviations) {
      const list = byUnit.get(deviation.unitId) ?? []
      list.push(deviation)
      byUnit.set(deviation.unitId, list)
    }
    return byUnit
  }, [terminologyDeviations])

  // 回跳锚就是行号：点译文格子 ⇒ 标出**同一行**的原文格子（共享层给的映射，面板不猜）。
  const highlight = useCallback((rowIndex: number) => {
    setHighlightedRow((current) => (current === rowIndex ? undefined : rowIndex))
  }, [])

  const columns = TRANSLATION_READING_COLUMNS[mode]

  const cellWording = (row: ReadingRow): string => {
    if (row.translation.kind === 'translated') return row.translation.text
    if (row.translation.kind === 'failed') {
      return `${t('translation.cell.failed')} —— ${row.translation.reason || t('translation.reason.missing')}`
    }
    if (row.translation.kind === 'kept') return t('translation.cell.kept')
    return t('translation.cell.missing')
  }

  return (
    <div data-slot="translation-panel" className="flex min-h-0 flex-col gap-2 text-[11px]">
      <div className="flex items-center gap-2">
        <span className="flex items-center gap-1" data-slot="translation-modes">
          {TRANSLATION_READING_MODES.map((candidate) => (
            <Button
              key={candidate}
              type="button"
              variant="ghost"
              size="xs"
              data-slot={`translation-mode-${candidate}`}
              aria-pressed={candidate === mode}
              data-selected={candidate === mode}
              className={cn(candidate === mode ? 'text-primary' : 'text-text-100')}
              onClick={() => onModeChange(candidate)}
            >
              {t(MODE_KEYS[candidate])}
            </Button>
          ))}
        </span>
        {onExportContrast && rows.length > 0 ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            data-slot="translation-export"
            onClick={onExportContrast}
          >
            {t('translation.contrast.export')}
          </Button>
        ) : null}
        {exportNote ? (
          <span data-slot="translation-export-note" className="text-text-300">
            {exportNote}
          </span>
        ) : null}
      </div>

      {pageStatuses.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2" data-slot="translation-page-statuses">
          {pageStatuses.map((status) => (
            <span
              key={status.page}
              data-slot={`translation-page-status-${status.page}`}
              data-kind={status.kind}
              className={cn(
                'rounded-sm px-1.5 py-0.5',
                status.kind === 'no-text-layer' ? 'bg-bg-200/70 text-text-300' : 'text-text-200'
              )}
            >
              {`${status.page} · ${t(PAGE_STATUS_KEYS[status.kind])} · ${status.translated}/${status.paragraphs}`}
            </span>
          ))}
        </div>
      ) : null}

      <div className="flex min-h-0 flex-col gap-2 overflow-auto" data-slot="translation-rows">
        {rows.map((row) => (
          <div
            key={row.unitId}
            data-slot={`translation-row-${row.unitId}`}
            data-row-index={row.rowIndex}
            className="grid grid-cols-2 gap-2"
          >
            {columns.source ? (
              <div
                data-slot={`translation-source-${row.unitId}`}
                data-highlighted={highlightedRow === row.rowIndex ? 'true' : 'false'}
                className={cn(
                  'rounded-sm px-1 py-0.5',
                  highlightedRow === row.rowIndex ? 'bg-primary/15' : 'bg-bg-200/40'
                )}
              >
                {row.source ?? t('translation.source.missing')}
              </div>
            ) : null}
            {columns.translation ? (
              <button
                type="button"
                data-slot={`translation-cell-${row.unitId}`}
                data-kind={row.translation.kind}
                className="rounded-sm bg-bg-200/70 px-1 py-0.5 text-left"
                onClick={() => highlight(row.rowIndex)}
              >
                {cellWording(row)}
              </button>
            ) : null}
            {(deviationsByUnit.get(row.unitId) ?? []).map((deviation) => (
              <span
                key={`${row.unitId}:${deviation.english}`}
                data-slot={`translation-deviation-${row.unitId}`}
                className="col-span-2 text-text-300"
              >
                {t('translation.terminology.deviation', {
                  term: deviation.english,
                  accepted: deviation.accepted.join(' / ')
                })}
              </span>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
