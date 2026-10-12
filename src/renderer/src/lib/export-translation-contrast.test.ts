import { describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_TRANSLATION_CONTRAST_LABELS,
  TRANSLATION_CONTRAST_RECIPE,
  buildTranslationContrast
} from '../../../shared/translation-contrast'
import type { TranslationRecord, TranslationUnit } from '../../../shared/translation-units'
import {
  exportTranslationContrast,
  translationContrastFileName
} from './export-translation-contrast'

const units: TranslationUnit[] = [
  { id: 'p1#1', page: 1, paragraph: 1, text: 'First paragraph.' },
  { id: 'p1#2', page: 1, paragraph: 2, text: 'Second paragraph.' }
]

const records: Record<string, TranslationRecord> = {
  'p1#1': {
    id: 'p1#1',
    page: 1,
    sourceHash: 'h',
    status: 'translated',
    text: '第一段。',
    updatedAt: 1
  }
}

const document = (): ReturnType<typeof buildTranslationContrast> =>
  buildTranslationContrast({
    sourceId: 'paper-1',
    sourceContentHash: 'hash-1',
    units,
    records,
    sourcePages: 1
  })

describe('A7 导出入口（走既有 file:save-blob，不新开通道）', () => {
  it('送出去的字节就是构建器产出的那一份（含配方与计数头），用 UTF-8 与 text/markdown', async () => {
    const saveBlobFile = vi
      .fn()
      .mockResolvedValue({ saved: true, filePath: '/tmp/paper-1-contrast.md' })
    const result = await exportTranslationContrast({ document: document() }, { saveBlobFile })

    expect(result).toEqual({ saved: true, fileName: 'paper-1-contrast.md' })
    expect(saveBlobFile).toHaveBeenCalledTimes(1)
    const request = saveBlobFile.mock.calls[0]?.[0] as {
      suggestedName: string
      mimeType: string
      data: ArrayBuffer
    }
    expect(request.suggestedName).toBe('paper-1-contrast.md')
    expect(request.mimeType).toBe('text/markdown')

    // 字节解码回来必须是同一份 Markdown（文件里的话＝测试断言的话），中文按 UTF-8 原样。
    const text = new TextDecoder().decode(new Uint8Array(request.data))
    expect(text).toContain(TRANSLATION_CONTRAST_RECIPE)
    expect(text).toContain('hash-1')
    expect(text).toContain('第一段。')
    // 未译的那一段留在文件里并被计入（不是被删掉）。
    expect(text).toContain('**本段尚无译文**')
    expect(text).toContain('段落：2')
  })

  it('送出的字节不多不少（buffer 切片：多一个字节就是另一个文件）', async () => {
    const saveBlobFile = vi.fn().mockResolvedValue({ saved: true })
    const result = await exportTranslationContrast({ document: document() }, { saveBlobFile })
    expect(result.saved).toBe(true)
    const request = saveBlobFile.mock.calls[0]?.[0] as { data: ArrayBuffer }
    const markdown = new TextDecoder().decode(new Uint8Array(request.data))
    // 用 UTF-8 重新编码同一段文本，长度必须一致 ⇒ 没有夹带（也没有截断）。
    expect(new TextEncoder().encode(markdown).byteLength).toBe(request.data.byteLength)
  })

  it('没有桥 ⇒ 具名 no-bridge（不是静默失败，也不是崩）', async () => {
    // node 环境里没有 `window`；也不给注入替身 ⇒ 只能如实回一句「没发起」。
    const result = await exportTranslationContrast({ document: document() })
    expect(result).toEqual({ saved: false, fileName: 'paper-1-contrast.md', reason: 'no-bridge' })
  })

  it('被审批卡拒绝 ⇒ 如实转达「没有写出任何文件」', async () => {
    const saveBlobFile = vi.fn().mockResolvedValue({ saved: false, refused: 'approval-denied' })
    const result = await exportTranslationContrast({ document: document() }, { saveBlobFile })
    expect(result).toEqual({
      saved: false,
      fileName: 'paper-1-contrast.md',
      refused: 'approval-denied'
    })
  })

  it('文件名：路径与空格压成安全的一段，空 id 有兜底，明确标出是对照件', () => {
    expect(translationContrastFileName('paper-1')).toBe('paper-1-contrast.md')
    expect(translationContrastFileName('/data/workspaces/session-1/我的论文.pdf')).toBe(
      'data-workspaces-session-1-我的论文.pdf-contrast.md'
    )
    expect(translationContrastFileName('   ')).toBe('document-contrast.md')
    // 绝不带路径分隔符（否则就是往别的目录写）。
    expect(translationContrastFileName('a/b\\c')).not.toMatch(/[\\/]/)
  })

  it('措辞可注入 ⇒ 导出件能跟着界面语言走', async () => {
    const saveBlobFile = vi.fn().mockResolvedValue({ saved: true })
    await exportTranslationContrast(
      {
        document: document(),
        labels: { ...DEFAULT_TRANSLATION_CONTRAST_LABELS, heading: 'Side-by-side' }
      },
      { saveBlobFile }
    )
    const request = saveBlobFile.mock.calls[0]?.[0] as { data: ArrayBuffer }
    // 注入的措辞真的进了文件头（9 语导出的路径不是装饰）。
    expect(new TextDecoder().decode(new Uint8Array(request.data))).toContain('# Side-by-side')
  })
})
