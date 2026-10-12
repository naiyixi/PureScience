// A7 的导出入口：把对照件写成文件。
//
// 两条本仓纪律体现在这里：
//
//  1. **不开新通道**：走既有的 `file:save-blob`（主进程弹保存对话框并落盘）。对照件是纯文本，
//     不需要任何新的能力面；新开通道的代价是那一整套计数级联，而这里一个都用不上。
//  2. **落盘的内容就是构建器产出的那一份**：字节从 `renderTranslationContrastMarkdown(document)` 来，
//     不在这里另拼一份文本（另拼一份意味着文件里的话和测试断言的话可能是两回事）。
//
// 「没有桥」是具名结果（`no-bridge`），不是静默失败：在没有 `window.api` 的环境里（node 测试、
// 或窗口还没装好桥）调用时，调用方要能说清「没写出任何文件」以及为什么。

import {
  DEFAULT_TRANSLATION_CONTRAST_LABELS,
  renderTranslationContrastMarkdown,
  type ContrastDocument,
  type TranslationContrastLabels
} from '../../../shared/translation-contrast'

type SaveBlobFileResult = { saved: boolean; filePath?: string; refused?: 'approval-denied' }

export type TranslationContrastExportReason = 'no-bridge'

export type TranslationContrastExportResult = {
  saved: boolean
  /** 建议的文件名（无论成败都回，调用方要能告诉用户「打算写到哪」）。 */
  fileName: string
  /** 主进程拒绝了（审批卡）⇒ 没有写出任何文件。 */
  refused?: 'approval-denied'
  /** 压根没法发起（没有桥）。 */
  reason?: TranslationContrastExportReason
}

export type TranslationContrastExportDeps = {
  /** 缺省走窗口桥；注入替身是为了在 node 环境里断言「送出去的字节是什么」。 */
  saveBlobFile?: (request: {
    suggestedName: string
    mimeType: string
    data: ArrayBuffer
  }) => Promise<SaveBlobFileResult>
}

/** 文件名：源 id 可能是一串路径或带空格的中文名，压成安全的一段，并明确标出这是对照件。 */
export const translationContrastFileName = (sourceId: string): string => {
  const safe = sourceId
    .replace(/[\\/]+/g, '-')
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^[-.]+|-+$/g, '')
    .slice(0, 80)
  return `${safe === '' ? 'document' : safe}-contrast.md`
}

export const exportTranslationContrast = async (
  {
    document,
    labels = DEFAULT_TRANSLATION_CONTRAST_LABELS,
    fileName
  }: {
    document: ContrastDocument
    labels?: TranslationContrastLabels
    fileName?: string
  },
  deps: TranslationContrastExportDeps = {}
): Promise<TranslationContrastExportResult> => {
  const suggestedName = fileName ?? translationContrastFileName(document.sourceId)
  const save =
    deps.saveBlobFile ??
    (typeof window === 'undefined'
      ? undefined
      : (window.api?.saveBlobFile?.bind(window.api) as
          TranslationContrastExportDeps['saveBlobFile'] | undefined))

  if (!save) return { saved: false, fileName: suggestedName, reason: 'no-bridge' }

  const markdown = renderTranslationContrastMarkdown(document, labels)
  const bytes = new TextEncoder().encode(markdown)
  // `TextEncoder` 的 buffer 可能是共享的池 ⇒ 切出**正好这一段**再送出去（多送一个字节就是另一个文件）。
  const data = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer

  const result = await save({ suggestedName, mimeType: 'text/markdown', data })
  return {
    saved: result.saved,
    fileName: suggestedName,
    ...(result.refused ? { refused: result.refused } : {})
  }
}
