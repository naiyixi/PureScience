// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { LanguageProvider } from '@/i18n'
import type { PdfTranslationWindowResult } from '../../../../../../shared/pdf'
import { segmentPageIntoTranslationUnits } from '../../../../../../shared/translation-units'
import { buildTranslationViewModel } from '../../../../../../shared/translation-view-model'
import { PdfTranslationPanel } from './PdfTranslationPanel'

// A1 第三片，渲染层：窗口侧的翻译入口。
//
// 这一层测的是**接线与措辞**，不是引擎（引擎各自有它自己的套件）：
//  1. 打开面板 = 只读（`run` 不出现），按下「翻译」才带 `run: true` —— 打开文件不该静默跑一次付费调用；
//  2. 三种具名拒绝各上各的屏，且**没有运行报告**（不谎报跑过）；
//  3. 没有桥时给一句具名的话，而不是一个点了没反应的空面板；
//  4. 对照件导出走既有 `file:save-blob`，写出名字与「被拒绝」各说各的。
//
// 视图模型用**真构建器**算（不是手写一份假的行数据）：面板显示的就是产品会显示的那份。

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

const PAGE_TEXT = 'First paragraph.\n\nSecond paragraph.'

const units = segmentPageIntoTranslationUnits(1, PAGE_TEXT)
const firstUnit = units[0]!
const secondUnit = units[1]!

const view = buildTranslationViewModel({
  sourceId: 'doc-1',
  sourceContentHash: 'source-hash-1',
  pages: [{ page: 1, text: PAGE_TEXT }],
  records: {
    // 渲染路径只看状态与正文（摘要由引擎的复用计划核对），所以这里只要一条状态为 translated 的记录。
    [firstUnit.id]: {
      id: firstUnit.id,
      page: 1,
      sourceHash: 'record-hash-1',
      status: 'translated',
      text: '第一段。',
      updatedAt: 1
    }
  }
})

const result = (
  overrides: Partial<PdfTranslationWindowResult> = {}
): PdfTranslationWindowResult => ({
  ran: false,
  restored: { state: 'partial', records: 1 },
  view,
  ...overrides
})

const settle = async (): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

const item = (selector: string): HTMLElement | null =>
  container.querySelector(selector) as HTMLElement | null

const mount = async (): Promise<void> => {
  await act(async () => {
    root.render(
      <LanguageProvider>
        <PdfTranslationPanel path="paper.pdf" projectId="project-1" sessionId="session-1" />
      </LanguageProvider>
    )
  })
  await settle()
}

const stubBridge = (
  translation: (request: unknown) => Promise<PdfTranslationWindowResult>,
  saveBlobFile?: (request: unknown) => Promise<{ saved: boolean; refused?: 'approval-denied' }>
): void => {
  window.api = {
    pdf: { translation },
    ...(saveBlobFile ? { saveBlobFile } : {})
  } as unknown as Window['api']
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

describe('A1 窗口侧翻译入口', () => {
  it('打开面板只读：不带 run 地取一次，行与「已存多少段」上屏；按「翻译」才带 run: true', async () => {
    const translation = vi.fn().mockResolvedValue(result())
    stubBridge(translation)
    await mount()

    expect(translation).toHaveBeenCalledTimes(1)
    expect(translation.mock.calls[0]?.[0]).toEqual({
      projectId: 'project-1',
      path: 'paper.pdf',
      sessionId: 'session-1'
    })

    // 阅读面板真的渲染了：两段原文、一段有译文。
    expect(item(`[data-slot="translation-source-${firstUnit.id}"]`)?.textContent).toContain(
      'First paragraph.'
    )
    expect(item(`[data-slot="translation-cell-${firstUnit.id}"]`)?.textContent).toContain(
      '第一段。'
    )
    expect(item(`[data-slot="translation-cell-${secondUnit.id}"]`)?.getAttribute('data-kind')).toBe(
      'missing'
    )
    expect(item('[data-testid="pdf-translation-stored"]')?.textContent).toContain(
      '1 paragraphs already stored'
    )
    // 还没跑 ⇒ 没有运行报告。
    expect(item('[data-testid="pdf-translation-report"]')).toBeNull()

    translation.mockResolvedValue(
      result({
        ran: true,
        run: {
          model: 'deepseek-v4-flash',
          translated: 1,
          reused: 1,
          failed: 0,
          skipped: 0,
          stopped: null,
          checkpointPath: '/tmp/checkpoints/doc-1.json'
        }
      })
    )
    await act(async () => {
      item('[data-slot="pdf-translation-run"]')?.click()
    })
    await settle()

    expect(translation).toHaveBeenCalledTimes(2)
    expect(translation.mock.calls[1]?.[0]).toMatchObject({ run: true, path: 'paper.pdf' })
    const report = item('[data-testid="pdf-translation-report"]')
    expect(report?.textContent).toContain('Translated 1')
    expect(report?.textContent).toContain('reused 1')
    expect(report?.textContent).toContain('deepseek-v4-flash')
  })

  it('没有模型端点：具名拒绝上屏，且不出现任何运行报告（不谎报跑过）', async () => {
    const translation = vi.fn().mockResolvedValue(
      result({
        refusal: {
          reason: 'not-configured',
          detail: 'No provider and model are configured for translation.'
        }
      })
    )
    stubBridge(translation)
    await mount()

    const refusal = item('[data-testid="pdf-translation-refusal"]')
    expect(refusal?.textContent).toContain('No model endpoint is configured')
    expect(item('[data-testid="pdf-translation-report"]')).toBeNull()
    // 视图仍在（读者至少能看到原文），面板不是一块空白。
    expect(item(`[data-slot="translation-source-${firstUnit.id}"]`)).not.toBeNull()
  })

  it('没有可翻段落：与「没有端点」是两句不同的话', async () => {
    stubBridge(
      vi.fn().mockResolvedValue(
        result({
          refusal: { reason: 'empty-source', detail: '这一份里没有可翻译的段落' }
        })
      )
    )
    await mount()

    expect(item('[data-testid="pdf-translation-refusal"]')?.textContent).toContain(
      'no paragraphs to translate'
    )
  })

  it('窗口里没有这条桥：给一句具名的话，不渲染空壳面板', async () => {
    window.api = {} as unknown as Window['api']
    await mount()

    expect(item('[data-testid="pdf-translation-unavailable"]')?.textContent).toContain(
      'not reachable from this window'
    )
    expect(item('[data-slot="translation-rows"]')).toBeNull()
  })

  it('对照件导出走既有 save-blob，并说出写出的文件名；被拒绝也具名', async () => {
    const saveBlobFile = vi.fn().mockResolvedValue({ saved: true })
    stubBridge(vi.fn().mockResolvedValue(result()), saveBlobFile)
    await mount()

    await act(async () => {
      item('[data-slot="translation-export"]')?.click()
    })
    await settle()

    expect(saveBlobFile).toHaveBeenCalledTimes(1)
    const request = saveBlobFile.mock.calls[0]?.[0] as {
      suggestedName: string
      mimeType: string
      data: ArrayBuffer
    }
    expect(request.suggestedName).toBe('doc-1-contrast.md')
    expect(request.mimeType).toBe('text/markdown')
    expect(request.data.byteLength).toBeGreaterThan(0)

    const note = item('[data-slot="translation-export-note"]')
    expect(note?.textContent).toContain('doc-1-contrast.md')

    // 审批被拒 ⇒ 没有写出任何文件，这一句要说出来。
    saveBlobFile.mockResolvedValue({ saved: false, refused: 'approval-denied' })
    await act(async () => {
      item('[data-slot="translation-export"]')?.click()
    })
    await settle()
    expect(item('[data-slot="translation-export-note"]')?.textContent).toContain('was not approved')
  })
})
