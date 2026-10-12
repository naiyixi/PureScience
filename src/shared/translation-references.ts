// A5 的判据层：**哪些段落是参考文献条目**（因此不翻译、原样保留）。
//
// 参考文献是唯一一处「翻译反而是错」的正文块：期刊名要原样、作者名要原样、编号与卷期页要原样，
// 一个译过的文献条目既读不出原文、也没法拿去查 —— 所以这一块不翻。
//
// 这条判据的方向性很要紧，所以写成**保守的**：
//
//   - 假阳（把正文段落当成文献、于是没翻）**丢内容**，是最坏的一种错；
//   - 假阴（漏认一条文献、于是翻了它）只是让引文里混了中文，读者看得出来、也改得回来。
//
// 所以判定要**两个信号同时成立**：
//   ① 开头有引文标记（`[12]` / `12.` / `(12)`）—— 段落以它开头，而不是句中提到；
//   ② 段内有书目信号（`(2001)` 这类四位年 / DOI / `et al.` / 卷(期): 页 这类页码模式 / PMID）。
// 只有一个信号不判 —— 正文里 `[12]` 这种引用标记很常见，光凭它跳过一整段是在拿内容赌博。
//
// 另外，「一个块」才算：**末尾连续 ≥2 条**才认定为参考文献区。孤零零一条留在末尾时只报出来
// （`single-entry`）而不跳过 —— 末尾那一段很可能只是正文的最后一句。

// 注意 `u` 标志：没有它时 `[\p{L}\d]` 里的 `\p{L}` 会被当成字面字符（`p`、`{`、`L`、`}`），
// 于是「`[1] Smith` 以引文标记开头」这条永远不成立 —— 判据静默失效。
const CITATION_MARKER = /^\s*(?:\[\d{1,4}\]|\(\d{1,4}\)|\d{1,4}[.)])\s*[\p{L}\d]/u

const BIBLIOGRAPHIC_SIGNALS: readonly RegExp[] = [
  // 四位年，通常在括号里：`(2001)` / `(2001a)`
  /\((?:19|20)\d{2}[a-z]?\)/u,
  // DOI（无论写不写 doi: 前缀）
  /10\.\d{4,9}\/\S+/u,
  // `et al.` / `e tal`（列表里常见的省略写法）
  /\bet\s+al\.?/iu,
  // 卷(期): 页 或 卷: 页
  /\b\d{1,4}\s*(?:\(\d{1,3}\))?\s*:\s*\d{1,6}(?:\s*[-–]\s*\d{1,6})?\b/u,
  // 显式的标识符
  /\b(?:PMID|PMCID|doi|arXiv)\b:?\s*\S+/iu,
  // 期刊名后跟年份/卷期的常见形态：`J. Foo. 12, 345 (2001)`
  /\b[JJ]\.\s*[\p{L}]+\.\s*\d/u
]

export const isReferenceEntry = (paragraph: string): boolean => {
  const text = paragraph.trim()
  if (text === '') return false
  if (!CITATION_MARKER.test(text)) return false
  return BIBLIOGRAPHIC_SIGNALS.some((signal) => signal.test(text))
}

export type ReferenceBlockDetection = {
  /** 判定为文献条目的段落序号（0-based，指向传进来的数组）。 */
  entries: number[]
  /**
   * `numbered-block`：末尾连续 ≥2 条 ⇒ 这是参考文献区，调用方**跳过**这些段落；
   * `single-entry`：末尾只有一条 ⇒ **报出来但不跳过**（很可能只是正文最后一句里的引用标记）；
   * `none`：没找到。
   */
  reason: 'numbered-block' | 'single-entry' | 'none'
  /** 要跳过的连续区间 `[start, end]`（含端点）；`none` / `single-entry` 时为 undefined。 */
  block?: { start: number; end: number }
}

export const detectReferenceBlock = (paragraphs: readonly string[]): ReferenceBlockDetection => {
  const entries: number[] = []
  paragraphs.forEach((paragraph, index) => {
    if (isReferenceEntry(paragraph)) entries.push(index)
  })

  if (entries.length === 0) return { entries, reason: 'none' }

  // 只认**末尾**那一段连续区：文献区在正文之后，中间出现的条目不成区。
  let end = paragraphs.length - 1
  while (end >= 0 && !entries.includes(end)) end -= 1
  if (end < 0) return { entries, reason: 'none' }

  let start = end
  while (start - 1 >= 0 && entries.includes(start - 1)) start -= 1

  const length = end - start + 1
  if (length < 2) return { entries, reason: 'single-entry' }
  return { entries, reason: 'numbered-block', block: { start, end } }
}

/**
 * 把段落切成「要翻的」与「原样保留的」两半（供调用方在切单元之前分流）。
 * 返回序数对：`translatable` 是要送翻译的段落（保持原顺序），`kept` 是文献区段落。
 */
export const splitReferenceParagraphs = (
  paragraphs: readonly string[]
): {
  translatable: { index: number; text: string }[]
  kept: { index: number; text: string }[]
  detection: ReferenceBlockDetection
} => {
  const detection = detectReferenceBlock(paragraphs)
  const block = detection.block
  const translatable: { index: number; text: string }[] = []
  const kept: { index: number; text: string }[] = []
  paragraphs.forEach((text, index) => {
    if (block && index >= block.start && index <= block.end) kept.push({ index, text })
    else translatable.push({ index, text })
  })
  return { translatable, kept, detection }
}
