import type { PdfOutlineEntry } from './pdf'

// A paper's bookmarks are in print order; the order a reader can actually follow is not. Methods come after an
// abstract and before results, references are not part of the argument at all, and a section called "Cell lines"
// is part of methods even though its own name says nothing about it. This module turns an outline into that
// order — without reading a single page — and says for every entry whether it is part of the argument, context,
// or nothing to read.
export type ReadingRole =
  | 'abstract'
  | 'introduction'
  | 'background'
  | 'methods'
  | 'results'
  | 'discussion'
  | 'conclusion'
  | 'other'
  | 'appendix'
  | 'acknowledgements'
  | 'references'

export type ReadingAction = 'read' | 'skim' | 'skip'

export type ReadingOrderItem = {
  entry: PdfOutlineEntry
  role: ReadingRole
  action: ReadingAction
  // Document position, so the UI can say "p. 7" and a reader can still see where it sits in print.
  documentIndex: number
}

export type ReadingOrderPlan = {
  items: ReadingOrderItem[]
  empty: 'no-outline' | null
}

export const READING_ROLE_ORDER: ReadingRole[] = [
  'abstract',
  'introduction',
  'background',
  'methods',
  'results',
  'discussion',
  'conclusion',
  'other',
  'appendix',
  'acknowledgements',
  'references'
]

const ACTION_BY_ROLE: Record<ReadingRole, ReadingAction> = {
  abstract: 'read',
  introduction: 'read',
  background: 'skim',
  methods: 'read',
  results: 'read',
  discussion: 'read',
  conclusion: 'read',
  other: 'read',
  appendix: 'skim',
  acknowledgements: 'skip',
  references: 'skip'
}

// The words a section can be called in the nine languages this product ships, written the way a heading is
// actually titled ("Materials and methods", "材料与方法", "2.1 実験方法"), never as a bare substring that would
// also match "Introduction of a new drug" inside a methods section.
// A heading ends at the end of the string or at a separator. `\b` cannot be used: it is defined on ASCII word
// characters, so a Chinese heading like "引言" has no boundary to match and would never be recognised.
const TERMINATOR = '(?=$|[\\s:：,，.。;；\\-–—(（、·])'
const heading = (terms: string): RegExp => new RegExp(`^(${terms})${TERMINATOR}`, 'i')

const ROLE_PATTERNS: Array<{ role: ReadingRole; pattern: RegExp }> = [
  {
    role: 'abstract',
    pattern: heading(
      '(abstract|summary|synopsis|摘要|概要|要旨|초록|요약|résumé|resume|zusammenfassung|resumen|аннотация)'
    )
  },
  {
    role: 'introduction',
    pattern: heading(
      '(introduction|intro|引言|前言|序言|绪论|はじめに|序論|서론|einleitung|introducción|introduccion|введение)'
    )
  },
  {
    role: 'background',
    pattern: heading(
      "(background|related work|related works|literature review|state of the art|研究背景|相关工作|文献综述|関連研究|先行研究|선행 ?연구|stand der forschung|estado del arte|état de l['’]art|обзор литературы)"
    )
  },
  {
    role: 'methods',
    pattern: heading(
      '(methods?|methodology|materials? and methods?|experimental( procedures| section)?|patients and methods|方法|方法学|材料与方法|材料和方法|実験方法|実験|방법|방법론|méthodes?|methoden|métodos|методы|методика)'
    )
  },
  {
    role: 'results',
    pattern: heading(
      '(results?|findings|结果|結果|결과|ergebnisse|resultados|résultats|результаты)'
    )
  },
  {
    role: 'discussion',
    pattern: heading(
      '(discussion|讨论|討論|考察|논의|고찰|diskussion|discusión|discussion et|обсуждение)'
    )
  },
  {
    role: 'conclusion',
    pattern: heading(
      '(conclusions?|concluding remarks|summary and outlook|结论|结语|總結|結論|まとめ|결론|schlussfolgerung|fazit|conclusión|conclusiones|заключение|выводы)'
    )
  },
  {
    role: 'appendix',
    pattern: heading(
      '(appendix|appendices|supplementary|supplemental|supporting information|附录|附錄|补充材料|補充資料|付録|補足資料|부록|anhang|anexo|annexe|приложение)'
    )
  },
  {
    role: 'acknowledgements',
    pattern: heading(
      '(acknowledg(e)?ments?|acknowledgments|致谢|致謝|謝辞|감사의 ?글|danksagung|agradecimientos|remerciements|благодарности)'
    )
  },
  {
    role: 'references',
    pattern: heading(
      '(references?|bibliography|works cited|cited literature|参考文献|參考文獻|引用文献|참고 ?문헌|literaturverzeichnis|literatur|références|referencias|библиография|литература|список литературы)'
    )
  }
]

// A heading often carries a number and a subtitle ("2. Materials and methods", "3.1 Cell lines"): the number is
// stripped before matching, the subtitle is what decides.
const stripHeadingNumber = (title: string): string =>
  title
    .replace(/^\s*(\d+(\.\d+)*|[ivxlc]+|[A-Z])([.)、]\s*|\s+)/, '')
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .trim()

const classify = (title: string): ReadingRole | undefined => {
  const stripped = stripHeadingNumber(title)
  for (const { role, pattern } of ROLE_PATTERNS) {
    if (pattern.test(stripped) || pattern.test(title.trim())) return role
  }
  return undefined
}

/**
 * Builds the reading plan. Subheadings inherit the role of the section they sit under, which is what makes
 * "Cell lines" part of methods; a heading that matches nothing and has no parent is `other` and keeps its place
 * at the end, in print order, rather than being dropped.
 */
export const planReadingOrder = (outline: readonly PdfOutlineEntry[]): ReadingOrderPlan => {
  if (outline.length === 0) return { items: [], empty: 'no-outline' }

  const roles: ReadingRole[] = []
  // level → role of the nearest heading at or above that level, so a subsection can inherit.
  const stack: Array<{ level: number; role: ReadingRole }> = []

  outline.forEach((entry, index) => {
    const own = classify(entry.title)
    let role: ReadingRole
    if (own) {
      role = own
    } else {
      while (stack.length > 0 && (stack[stack.length - 1]?.level ?? 0) >= entry.level) stack.pop()
      const parent = stack[stack.length - 1]
      role = parent && parent.role !== 'other' ? parent.role : 'other'
    }
    while (stack.length > 0 && (stack[stack.length - 1]?.level ?? 0) >= entry.level) stack.pop()
    stack.push({ level: entry.level, role })
    roles[index] = role
  })

  const items: ReadingOrderItem[] = outline.map((entry, index) => ({
    entry,
    role: roles[index] ?? 'other',
    action: ACTION_BY_ROLE[roles[index] ?? 'other'],
    documentIndex: index
  }))

  // Stable within a role: two "Results" sections (main text and supplement) keep print order.
  items.sort((left, right) => {
    const rank = READING_ROLE_ORDER.indexOf(left.role) - READING_ROLE_ORDER.indexOf(right.role)
    if (rank !== 0) return rank
    if (left.entry.page !== right.entry.page) return left.entry.page - right.entry.page
    return left.documentIndex - right.documentIndex
  })

  return { items, empty: null }
}

/** Counts for one line of UI text: what to read, what to skim, what the plan leaves out. */
export const summarizeReadingOrder = (
  plan: ReadingOrderPlan
): { read: number; skim: number; skip: number } => {
  const counts = { read: 0, skim: 0, skip: 0 }
  for (const item of plan.items) counts[item.action] += 1
  return counts
}
