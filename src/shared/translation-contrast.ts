// A7：**对照件**（原文 / 译文 并列）+ 可复算的配方。
//
// 「对照件」是对外的东西：它会被发给别人、被存档、被引用。所以这一层守三件事：
//
//  1. **自洽**：文件里出现的段落数、页数、已译/未译/失败各多少，与记录里的数字**逐个对得上**，
//     并且这些数字一起写进文件头。导出件说自己有多少段，就该真的有那么多段 —— 这是这个单元的验收判据。
//  2. **不静默补齐**：没有记录的段落**不省略**，而是以「本段尚无译文」出现在它原本的位置上并被计入。
//     一份把未译段落悄悄删掉的对照件，会让读者以为全文都翻过。
//  3. **可复算/可引用**：文件头带**配方名**与**源内容哈希**（哈希配方在 `translation-units.ts` 里公开）。
//     拿到同一份原文与同一批记录的人，能复算出同一份对照件，也能判断手上这份属于哪一版原文。
//
// 这一层是纯函数：不读盘、不联网、不认识存储。记录从哪来由调用方决定。

import type { TranslationRecord, TranslationUnit } from './translation-units'

/** 配方名进文件头：谁拿到这份对照件都能说出它是按哪一版规则生成的。 */
export const TRANSLATION_CONTRAST_RECIPE = 'purescience-translation-contrast-v1'

/**
 * 对照件里的**措辞**由调用方给（默认中文）。
 *
 * 为什么不写死：对照件是要发给别人看的文档，而本仓的界面文案一律 9 语。把中文句子钉在这个共享模块里，
 * 就等于给导出件加了一种「只有中文」的措辞，而渲染端再想本地化就没有口子了。
 * 默认值只是让**不需要**本地化的调用方（主进程/agent 路径）少写一步。
 */
export type TranslationContrastLabels = {
  heading: string
  recipeLabel: string
  sourceHashLabel: string
  pagesLabel: string
  paragraphsLabel: string
  translatedWord: string
  failedWord: string
  missingWord: string
  pagesWithoutParagraphsLabel: string
  originalLabel: string
  translatedLabel: string
  failedText: string
  missingText: string
  keptLabel: string
  keptText: string
  sourceMissingText: string
  reasonMissingText: string
  pageHeading: (page: number) => string
}

export const DEFAULT_TRANSLATION_CONTRAST_LABELS: TranslationContrastLabels = {
  heading: '对照件',
  recipeLabel: '配方',
  sourceHashLabel: '源内容哈希',
  pagesLabel: '页数',
  paragraphsLabel: '段落',
  translatedWord: '已译',
  failedWord: '失败',
  missingWord: '未译',
  pagesWithoutParagraphsLabel: '无段落的页',
  originalLabel: '原文',
  translatedLabel: '译文',
  failedText: '**未译（失败）**',
  missingText: '**本段尚无译文**（记录里没有这一段）',
  keptLabel: '原样保留',
  keptText: '**原文保留**（参考文献不翻译）',
  sourceMissingText: '（原文缺失）',
  reasonMissingText: '未说明原因',
  pageHeading: (page) => `第 ${page} 页`
}

export type ContrastParagraphStatus =
  | 'translated'
  | 'failed'
  | 'missing'
  /**
   * **原样保留**（A5：参考文献不翻译）。与 `missing` 分开是有意的：
   * 「这一条我们**决定不翻**」和「这一条**还没翻**」是两件事 —— 前者是完成状态，后者是待办。
   * 合成一态会让读者把「有意保留」读成「漏掉了」。
   */
  | 'kept'

export type ContrastParagraph = {
  unitId: string
  page: number
  paragraph: number
  part?: number
  status: ContrastParagraphStatus
  /** 原文。调用方给了才有 —— 缺原文时**不编**，如实为 undefined。 */
  source?: string
  /** 译文。只有 `translated` 才有；失败与缺失都不写空字符串。 */
  translated?: string
  /** `failed` 的具名原因。 */
  reason?: string
}

export type ContrastPage = { page: number; paragraphs: ContrastParagraph[] }

/** 原样保留的段落（参考文献区）：不进翻译单元，但要出现在对照件里、按原位排。 */
export type ContrastKeptParagraph = { page: number; paragraph: number; text: string }

export type ContrastCounts = {
  /** 对照件里真的出现的页数与段落数（就是下面两个数组的长度）。 */
  pages: number
  paragraphs: number
  translated: number
  failed: number
  missing: number
  /** 原样保留（参考文献）的段落数。与「未译」分开。 */
  kept: number
  /** 调用方声明的源页数，用来判「有没有整页没进来」。 */
  sourcePages: number
  /** 有页、但一个段落都没有的页（例如没有文本层）—— 具名列出，不装作没有。 */
  pagesWithoutParagraphs: number[]
}

export type ContrastDocument = {
  recipe: string
  sourceId: string
  sourceContentHash: string
  pages: ContrastPage[]
  counts: ContrastCounts
}

export type ContrastInput = {
  sourceId: string
  sourceContentHash: string
  units: readonly TranslationUnit[]
  /** 记录按 unitId 索引（存储读回来的就是这种形状）。 */
  records: Readonly<Record<string, TranslationRecord>>
  /** 源页数（用来报「有页没进来」）。缺省取出现过的最大页码。 */
  sourcePages?: number
  /** 原样保留的段落（参考文献）。出现在原位、参与计数，但状态是 `kept` 而不是 `missing`。 */
  kept?: readonly ContrastKeptParagraph[]
}

export const buildTranslationContrast = ({
  sourceId,
  sourceContentHash,
  units,
  records,
  sourcePages,
  kept
}: ContrastInput): ContrastDocument => {
  const byPage = new Map<number, ContrastParagraph[]>()

  for (const entry of kept ?? []) {
    const page = byPage.get(entry.page) ?? []
    page.push({
      // 保留段落的 id 说明它属于哪一页哪一段，并在前缀上与翻译单元区分开（它本来就不是单元）。
      unitId: `kept-p${entry.page}#${entry.paragraph}`,
      page: entry.page,
      paragraph: entry.paragraph,
      status: 'kept',
      source: entry.text
    })
    byPage.set(entry.page, page)
  }

  for (const unit of units) {
    const record = records[unit.id]
    const status: ContrastParagraphStatus =
      record === undefined
        ? 'missing'
        : record.status === 'translated' && (record.text ?? '') !== ''
          ? 'translated'
          : 'failed'
    const paragraph: ContrastParagraph = {
      unitId: unit.id,
      page: unit.page,
      paragraph: unit.paragraph,
      ...(unit.part !== undefined ? { part: unit.part } : {}),
      status,
      ...(unit.text !== undefined ? { source: unit.text } : {}),
      ...(status === 'translated' ? { translated: record?.text } : {}),
      ...(status === 'failed' ? { reason: record?.reason ?? '未说明原因' } : {})
    }
    const page = byPage.get(unit.page) ?? []
    page.push(paragraph)
    byPage.set(unit.page, page)
  }

  const pages: ContrastPage[] = [...byPage.entries()]
    .sort(([left], [right]) => left - right)
    .map(([page, paragraphs]) => ({
      page,
      // 同一页内按「段落号，再看 part」排 —— 长段落被切开的两半必须挨着，否则对照件读不成句。
      paragraphs: [...paragraphs].sort((left, right) =>
        left.paragraph === right.paragraph
          ? (left.part ?? 0) - (right.part ?? 0)
          : left.paragraph - right.paragraph
      )
    }))

  const all = pages.flatMap((page) => page.paragraphs)
  const declaredSourcePages = sourcePages ?? pages.at(-1)?.page ?? 0
  const pagesWithParagraphs = new Set(pages.map((page) => page.page))
  const pagesWithoutParagraphs: number[] = []
  for (let page = 1; page <= declaredSourcePages; page += 1) {
    if (!pagesWithParagraphs.has(page)) pagesWithoutParagraphs.push(page)
  }

  return {
    recipe: TRANSLATION_CONTRAST_RECIPE,
    sourceId,
    sourceContentHash,
    pages,
    counts: {
      pages: pages.length,
      paragraphs: all.length,
      translated: all.filter((paragraph) => paragraph.status === 'translated').length,
      failed: all.filter((paragraph) => paragraph.status === 'failed').length,
      missing: all.filter((paragraph) => paragraph.status === 'missing').length,
      kept: all.filter((paragraph) => paragraph.status === 'kept').length,
      sourcePages: declaredSourcePages,
      pagesWithoutParagraphs
    }
  }
}

const escapeCell = (value: string): string => value.replace(/\|/g, '\\|').replace(/\r?\n+/g, ' ')

/**
 * 渲染成 Markdown 对照件。文件头把配方、源哈希与两套计数写进去 —— 读者不必相信正文：
 * 数一数就知道对不对得上。
 */
export const renderTranslationContrastMarkdown = (
  document: ContrastDocument,
  labels: TranslationContrastLabels = DEFAULT_TRANSLATION_CONTRAST_LABELS
): string => {
  const { counts } = document
  const lines: string[] = [
    `# ${labels.heading} · ${document.sourceId}`,
    '',
    `- ${labels.recipeLabel}：${document.recipe}`,
    `- ${labels.sourceHashLabel}：${document.sourceContentHash}`,
    `- ${labels.pagesLabel}：${counts.pages} / ${counts.sourcePages}`,
    `- ${labels.paragraphsLabel}：${counts.paragraphs}（${labels.translatedWord} ${counts.translated} · ${labels.failedWord} ${counts.failed} · ${labels.missingWord} ${counts.missing} · ${labels.keptLabel} ${counts.kept}）${
      counts.pagesWithoutParagraphs.length > 0
        ? ` · ${labels.pagesWithoutParagraphsLabel}：${counts.pagesWithoutParagraphs.join('、')}`
        : ''
    }`,
    ''
  ]

  for (const page of document.pages) {
    lines.push(`## ${labels.pageHeading(page.page)}`, '')
    for (const paragraph of page.paragraphs) {
      const position =
        paragraph.part === undefined
          ? `${paragraph.paragraph}`
          : `${paragraph.paragraph}.${paragraph.part}`
      const original =
        paragraph.source === undefined ? labels.sourceMissingText : escapeCell(paragraph.source)
      lines.push(`### ${position}`, '', `- ${labels.originalLabel}：${original}`, '')
      if (paragraph.status === 'translated') {
        lines.push(`- ${labels.translatedLabel}：${escapeCell(paragraph.translated ?? '')}`, '')
      } else if (paragraph.status === 'failed') {
        lines.push(
          `- ${labels.translatedLabel}：${labels.failedText} —— ${escapeCell(paragraph.reason ?? labels.reasonMissingText)}`,
          ''
        )
      } else if (paragraph.status === 'kept') {
        // 有意保留：原文**逐字**在这里，并明说这一条不翻译。
        lines.push(`- ${labels.translatedLabel}：${labels.keptText}`, '')
      } else {
        // 未译的段落**留在原位**：删掉它会让读者以为全文都翻过了。
        lines.push(`- ${labels.translatedLabel}：${labels.missingText}`, '')
      }
    }
  }

  return lines.join('\n')
}
