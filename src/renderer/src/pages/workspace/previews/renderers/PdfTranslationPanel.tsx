// A1 第三片：窗口侧的翻译入口 —— 一条真缝，读与跑都是它。
//
// 为什么单独一层：段落级 PDF 翻译在这之前只有 agent 的工具面（`pdf_translate`），窗口里连一个按钮
// 都没有 —— 正是「能力在、界面上找不到」。这一层把三样**既有**的东西接起来：`pdf:translation` 通道
// （读回 / 运行）、A 线阅读面板（三种模式 + 逐页状态 + 术语偏离 + 回跳）、以及对照件导出
// （走既有 `file:save-blob`，不开新通道）。
//
// 三条它自己负责的规矩：
//  1. **打开面板只读，不跑模型**（`run` 缺省为 false）：打开一个文件不该静默产生一次付费调用；
//     「翻译」是一次显式的按下。所以先取一次存储里的记录，把阅读视图与「已存多少段」说清楚。
//  2. **拒绝具名上屏**：没有模型端点、这一份没有可翻段落，各说各的，不合成一句「翻译失败」——
//     前者能在设置里改，后者是文件自己的属性，读者要做的事完全不同。
//  3. **没有桥就说没有桥**：`window.api.pdf.translation` 不存在时给一句具名的话，而不是渲染一个
//     点了没反应的空面板（那是最难被发现的一种空壳）。
//
// 面板显示的一切都来自主进程的答复（行、逐页状态、偏离、真正用的模型、复用几段），这一层不自己算
// 一遍：算第二遍就等于允许两处对同一份文件说不同的话。

import { useCallback, useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { useLanguage, type TranslationKey } from '@/i18n'
import { exportTranslationContrast } from '@/lib/export-translation-contrast'
import type { PdfTranslationWindowResult } from '../../../../../../shared/pdf'
import type { TranslationReadingMode } from '../../../../../../shared/translation-reading'
import { TranslationPanel } from './TranslationPanel'

type TranslationState =
  | { status: 'loading' }
  | { status: 'ready'; result: PdfTranslationWindowResult }
  | { status: 'failed'; message: string }

/** 三种具名拒绝各自的那句话：原因由主进程给，措辞由这一层给。 */
const REFUSAL_KEYS = {
  'not-configured': 'pdfTranslation.refusal.notConfigured',
  'empty-source': 'pdfTranslation.refusal.emptySource',
  'invalid-request': 'pdfTranslation.refusal.other'
} as const satisfies Record<string, TranslationKey>

export type PdfTranslationPanelProps = {
  /** 读者正在看的那个文件（与预览持的是同一个字符串）。 */
  path: string
  projectId: string
  sessionId?: string
  onClose?: () => void
}

export const PdfTranslationPanel = ({
  path,
  projectId,
  sessionId,
  onClose
}: PdfTranslationPanelProps): React.JSX.Element => {
  const { t } = useLanguage()

  const [state, setState] = useState<TranslationState>({ status: 'loading' })
  const [running, setRunning] = useState(false)
  const [mode, setMode] = useState<TranslationReadingMode>('contrast')
  const [exportNote, setExportNote] = useState<string | undefined>(undefined)

  // 「这条桥在不在」是**渲染期就能算出来的事实**，不是运行结果：所以它是派生值，不是 state。
  //
  // 为什么非要这样写：`react-hooks/set-state-in-effect` 是 error 级门禁，它追进 `useCallback` 看到的
  // 同步 `setState` 也算违规 —— 把「没有桥」写进 `ask` 的开头，effect 的第一次调用就带着一条同步
  // 写入，门禁正确地拦下它。而派生值同时让这件事更硬：桥不在，就不会有一次调用发生，面板直接出
  // 那句具名的话（下面渲染处），不渲染任何空壳阅读区。
  const unavailable = typeof window.api?.pdf?.translation !== 'function'

  const ask = useCallback(
    async (run: boolean): Promise<void> => {
      const api = window.api?.pdf
      // 没有桥到这里就没有可做的事，也**不在这里同步写 state**：那句话由渲染期的 `unavailable` 说，
      // 而按钮在该状态下是禁用的 ⇒ 这条提前返回不可达，不是静默吞掉一次动作。
      if (typeof api?.translation !== 'function') return
      try {
        const result = await api.translation({
          projectId,
          path,
          ...(sessionId ? { sessionId } : {}),
          ...(run ? { run: true } : {})
        })
        setState({ status: 'ready', result })
      } catch (error) {
        setState({
          status: 'failed',
          message: error instanceof Error ? error.message : t('pdfTranslation.unavailable')
        })
      }
    },
    [path, projectId, sessionId, t]
  )

  // 只读的那一半：换文件/换项目就重取一次，一句模型调用都不发。
  //
  // 这里**不**在 effect 体内同步复位状态：初值已经是 `loading`，而「换了文件就重挂载」由父层的 `key`
  // 负责（`react-hooks/set-state-in-effect` 是 error 级门禁，正确做法是把复位交给挂载，而不是在 effect
  // 里再 set 一次）。
  useEffect(() => {
    if (unavailable) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- ask() awaits before any setState (fetch-on-mount); no cascading renders
    void ask(false)
  }, [ask, unavailable])

  const exportContrast = (): void => {
    if (state.status !== 'ready') return
    void exportTranslationContrast({ document: state.result.view.contrast })
      .then((outcome) => {
        if (outcome.saved) {
          setExportNote(t('pdfTranslation.exported', { name: outcome.fileName }))
          return
        }
        setExportNote(
          outcome.refused === 'approval-denied'
            ? t('pdfTranslation.exportDenied')
            : t('pdfTranslation.exportFailed')
        )
      })
      .catch((error: unknown) =>
        setExportNote(error instanceof Error ? error.message : t('pdfTranslation.exportFailed'))
      )
  }

  const result = state.status === 'ready' ? state.result : undefined
  const restoredNote =
    result === undefined
      ? undefined
      : result.restored.state === 'partial'
        ? t('pdfTranslation.stored.partial', { records: result.restored.records })
        : t('pdfTranslation.stored.none', { reason: result.restored.reason })

  return (
    <section
      data-testid="pdf-translation-panel"
      aria-label={t('pdfTranslation.panel.title')}
      className="absolute bottom-0 right-0 top-0 z-20 flex w-80 max-w-full flex-col gap-2 overflow-y-auto border-l border-border-300/50 bg-bg-000/95 px-3 py-2 backdrop-blur @max-[33rem]/pdf-pane:bottom-16"
    >
      <header className="flex items-center justify-between gap-2 border-b border-border-300/40 pb-1">
        <h2 className="text-[12px] font-medium text-text-000">{t('pdfTranslation.panel.title')}</h2>
        {onClose ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            data-slot="pdf-translation-close"
            onClick={onClose}
          >
            {t('common.close')}
          </Button>
        ) : null}
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="default"
          size="xs"
          data-slot="pdf-translation-run"
          disabled={unavailable || state.status === 'loading' || running}
          onClick={() => {
            setRunning(true)
            void ask(true).finally(() => setRunning(false))
          }}
        >
          {running ? t('pdfTranslation.running') : t('pdfTranslation.run')}
        </Button>
        {restoredNote ? (
          <span data-testid="pdf-translation-stored" className="text-[11px] text-text-300">
            {restoredNote}
          </span>
        ) : null}
      </div>

      {unavailable ? (
        <p
          data-testid="pdf-translation-unavailable"
          role="alert"
          className="text-[11px] text-rose-500"
        >
          {t('pdfTranslation.unavailable')}
        </p>
      ) : null}

      {!unavailable && state.status === 'loading' ? (
        <p data-testid="pdf-translation-loading" className="text-[11px] text-text-300">
          {t('pdfTranslation.loading')}
        </p>
      ) : null}

      {!unavailable && state.status === 'failed' ? (
        <p
          data-testid="pdf-translation-unavailable"
          role="alert"
          className="text-[11px] text-rose-500"
        >
          {state.message}
        </p>
      ) : null}

      {result?.refusal ? (
        <p data-testid="pdf-translation-refusal" role="alert" className="text-[11px] text-rose-500">
          {t(REFUSAL_KEYS[result.refusal.reason], { detail: result.refusal.detail })}
        </p>
      ) : null}

      {result?.run ? (
        <p data-testid="pdf-translation-report" className="text-[11px] text-text-200">
          {t('pdfTranslation.report', {
            translated: result.run.translated,
            reused: result.run.reused,
            failed: result.run.failed,
            model: result.run.model
          })}
        </p>
      ) : null}

      {result ? (
        <TranslationPanel
          rows={result.view.rows}
          pageStatuses={result.view.pageStatuses}
          terminologyDeviations={result.view.deviations}
          mode={mode}
          onModeChange={setMode}
          onExportContrast={exportContrast}
          {...(exportNote ? { exportNote } : {})}
        />
      ) : null}
    </section>
  )
}
