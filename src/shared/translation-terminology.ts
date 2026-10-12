// A4：译文的**术语一致性**校验 —— 用仓库里唯一那张中文术语表（`chinese-terms.ts`）来判，
// 偏离的段落**具名标注**（哪一段、哪个术语、认可的写法有哪些）。
//
// 这一层的价值全在「判据可复查」：判据不是这里另写的词表，而是那张表本身（每个 `method` 行还带着
// MeSH 标识符，任何人能在 id.nlm.nih.gov 上核对英文侧）。所以这里**只读表、不造数据**。
//
// 三条规矩：
//
//  1. **只判源文里真的出现过的术语**。源文没提的术语不参与 —— 否则会把「没人提过」报成「译文漏了」，
//     那是编出来的缺陷。同理，判过的条数要一起报（见第 3 条）。
//  2. **任一认可写法都算一致**：`canonical` 或任一 `variants`。表里 variant 存在的意义就是同一概念有多种
//     通行译名（`阿司匹林` / `乙酰水杨酸`），只认一种会把规范译名判成错。
//  3. **报了「判了多少条」才算数**：`deviations: []` 配上 `checked: 0` 只能读作「这份里没有被表覆盖的
//     术语」，**不能**读作「术语全部一致」。两种事实分开说，是这个仓库一贯的写法。
//
// 匹配口径（写清楚是为了可复查，不是为了聪明）：
//  - 英文侧：大小写不敏感、词边界匹配；多词术语里的空格/连字符互为等价（`meta-analysis` / `meta analysis`）；
//    额外允许一个复数后缀（`trial`/`trials`）。**不做词形还原** —— 那是另一件事，会带来假阳（把
//    `randomized` 当成 `randomize` 之类），而假阳在这条判据上是「冤枉译文」。
//  - 中文侧：CJK 没有词边界，所以用「包含」判定（先做与原文同样的空白归一）。这个方向的偏差是漏报
//    （少报一个偏离）而不是冤枉，故意的：这条判据宁少不冤。

import { CHINESE_TERMS, type ChineseTableEntry, type ChineseTermEntry } from './chinese-terms'
import { normalizeTranslationSource } from './translation-units'

export type TerminologyCheckInput = {
  unitId: string
  /** 原文（英文文献的段落）。 */
  source: string
  /** 这一段的中文译文。 */
  translated: string
}

export type TerminologyDeviation = {
  unitId: string
  /** 表里的英文术语（记录用词）。 */
  english: string
  /** 认可的写法：canonical 在前，随后是 variants。 */
  accepted: readonly string[]
}

export type TerminologyCheck = {
  /**
   * 真的查过的 **(段落, 术语) 对数**（源文里出现过且表里有）。为 0 时不能读作「全部一致」。
   */
  checked: number
  /** 逐条具名：哪一段、哪个术语、该用哪些写法。按 unitId 再按 english 排序（结果可复算）。 */
  deviations: readonly TerminologyDeviation[]
}

const isTermEntry = (entry: ChineseTableEntry): entry is ChineseTermEntry => 'english' in entry

/** 认可的写法：canonical 在前，其余按表里给出的顺序（去重）。 */
export const acceptedSpellings = (entry: ChineseTermEntry): readonly string[] => {
  const seen = new Set<string>()
  const accepted: string[] = []
  for (const spelling of [entry.canonical, ...(entry.variants ?? [])]) {
    const value = spelling.trim()
    if (value === '' || seen.has(value)) continue
    seen.add(value)
    accepted.push(value)
  }
  return accepted
}

const escapeForRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * 英文术语的出现判定：词边界 + 多词术语的空格/连字符等价 + 允许一个复数后缀。
 * 导出是为了可单测钉死（判据本身要能被复查，而不只是被使用）。
 */
export const englishTermOccursIn = (term: string, text: string): boolean => {
  const parts = term
    .trim()
    .split(/[\s-]+/)
    .filter((part) => part !== '')
  if (parts.length === 0) return false
  // 复数后缀只挂在**最后一个词**上（`randomized controlled trial` → trials ✓；不该出现 trialss/es 这种拼法）。
  const head = parts.slice(0, -1).map(escapeForRegExp)
  const tail = `${escapeForRegExp(parts[parts.length - 1] as string)}(?:s|es)?`
  const pattern = [...head, tail].join('[\\s-]+')
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${pattern}(?:$|[^\\p{L}\\p{N}])`, 'iu').test(text)
}

/** 中文侧：包含判定（CJK 无词边界）。两边都先做与哈希/发送同一套空白归一。 */
export const chineseSpellingPresent = (spelling: string, translated: string): boolean =>
  normalizeTranslationSource(translated).includes(normalizeTranslationSource(spelling))

export const checkTranslationTerminology = (
  entries: readonly TerminologyCheckInput[]
): TerminologyCheck => {
  const deviations: TerminologyDeviation[] = []
  let checked = 0

  for (const entry of entries) {
    const source = entry.source ?? ''
    const translated = entry.translated ?? ''
    for (const row of CHINESE_TERMS) {
      if (!isTermEntry(row)) continue
      if (!englishTermOccursIn(row.english, source)) continue

      checked += 1
      const accepted = acceptedSpellings(row)
      if (accepted.some((spelling) => chineseSpellingPresent(spelling, translated))) continue
      deviations.push({ unitId: entry.unitId, english: row.english, accepted })
    }
  }

  deviations.sort((left, right) =>
    left.unitId === right.unitId
      ? left.english.localeCompare(right.english)
      : left.unitId < right.unitId
        ? -1
        : 1
  )
  return { checked, deviations }
}
