// A6 的判据层：**逐页状态**，让「没有文本层」这件事自己开口。
//
// 这一层存在的理由是一个很容易被糊掉的区分：
//
//   一页「翻译了 0 段」有两种完全不同的成因 —— ① 这一页**没有文本层**（扫描件、纯图页），
//   ② 这一页有段落但**还没翻**。前者不是失败、也不该去重试；后者是待办。
//   两者都显示成「0/0」时，读者会以为翻译漏了这一页，而真相是这一页根本没有可翻的字。
//
// 所以状态是**逐页**给出的，并且带着数字（段落数、已译、失败、未译）—— 数字让人能复查：
// 「这一页 0 个段落」是事实陈述，不是我们替它下的结论。
//
// 另外两条：
//  - 状态带的是**文案键**而不是句子：本仓界面文案一律 9 语，句子写在渲染层的字典里。
//  - 失败与未译分开：一页全部段落都失败（`failed`）与一页还没开始（`untranslated`）修法不同 ——
//    前者要去看端点/报错，后者只要点一下继续。

import type { TranslationRecord, TranslationUnit } from './translation-units'

export const TRANSLATION_PAGE_STATUSES = [
  'no-text-layer',
  'untranslated',
  'partial',
  'translated',
  'failed'
] as const

export type TranslationPageStatusKind = (typeof TRANSLATION_PAGE_STATUSES)[number]

export type TranslationPageStatus = {
  page: number
  kind: TranslationPageStatusKind
  /** 这一页在源里分出了几个段落（0 ⇒ 没有文本层，这个数字就是那条判据）。 */
  paragraphs: number
  translated: number
  failed: number
  /** 有段落、但没有可用记录（未译）的段落数。 */
  missing: number
  /** 渲染层要显示的文案键（句子在字典里，不在这里）。 */
  labelKey: string
}

export type TranslationPageStatusesInput = {
  /** 源页数（用来把「有页但一个段落都没有」的那些页也报出来）。 */
  pageCount: number
  units: readonly TranslationUnit[]
  records: Readonly<Record<string, TranslationRecord>>
}

/** 每个状态对应的文案键（渲染层按它取 9 语句子）。 */
export const TRANSLATION_PAGE_LABEL_KEYS: Record<TranslationPageStatusKind, string> = {
  'no-text-layer': 'translation.page.noTextLayer',
  untranslated: 'translation.page.untranslated',
  partial: 'translation.page.partial',
  translated: 'translation.page.translated',
  failed: 'translation.page.failed'
}

const kindOf = (counts: {
  paragraphs: number
  translated: number
  failed: number
  missing: number
}): TranslationPageStatusKind => {
  if (counts.paragraphs === 0) return 'no-text-layer'
  if (counts.translated === counts.paragraphs) return 'translated'
  if (counts.translated > 0) return 'partial'
  if (counts.failed > 0 && counts.missing === 0) return 'failed'
  return 'untranslated'
}

export const translationPageStatuses = ({
  pageCount,
  units,
  records
}: TranslationPageStatusesInput): TranslationPageStatus[] => {
  const byPage = new Map<number, TranslationUnit[]>()
  for (const unit of units) {
    const page = byPage.get(unit.page) ?? []
    page.push(unit)
    byPage.set(unit.page, page)
  }

  const statuses: TranslationPageStatus[] = []
  for (let page = 1; page <= pageCount; page += 1) {
    const pageUnits = byPage.get(page) ?? []
    let translated = 0
    let failed = 0
    let missing = 0
    for (const unit of pageUnits) {
      const record = records[unit.id]
      if (record === undefined || (record.status === 'translated' && (record.text ?? '') === '')) {
        // 「没有记录」与「记录说翻过但没有文本」都是**没有可用译文**；后者不当作已译（空译文不是结果）。
        if (record?.status === 'failed') failed += 1
        else missing += 1
        continue
      }
      if (record.status === 'translated') translated += 1
      else failed += 1
    }
    const counts = { paragraphs: pageUnits.length, translated, failed, missing }
    const kind = kindOf(counts)
    statuses.push({ page, kind, ...counts, labelKey: TRANSLATION_PAGE_LABEL_KEYS[kind] })
  }
  return statuses
}

/** 一眼看全：每类状态各几页（面板首行用；也让「整篇没有文本层」这种事说得出口）。 */
export const translationPageStatusCounts = (
  statuses: readonly TranslationPageStatus[]
): Record<TranslationPageStatusKind, number> => {
  const counts: Record<TranslationPageStatusKind, number> = {
    'no-text-layer': 0,
    untranslated: 0,
    partial: 0,
    translated: 0,
    failed: 0
  }
  for (const status of statuses) counts[status.kind] += 1
  return counts
}
