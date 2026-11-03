import { describe, expect, it } from 'vitest'

import type { PdfOutlineEntry } from './pdf'
import { planReadingOrder, summarizeReadingOrder } from './reading-order'

const entry = (title: string, page: number, level = 1): PdfOutlineEntry => ({ title, page, level })

describe('planReadingOrder', () => {
  it('puts a paper in the order it can be read, not the order it is printed', () => {
    const plan = planReadingOrder([
      entry('1. Introduction', 1),
      entry('2. Materials and methods', 3),
      entry('3. Results', 7),
      entry('4. Discussion', 12),
      entry('5. Conclusion', 16),
      entry('6. References', 18),
      entry('Abstract', 1),
      entry('Acknowledgements', 17)
    ])

    expect(plan.items.map((item) => item.role)).toEqual([
      'abstract',
      'introduction',
      'methods',
      'results',
      'discussion',
      'conclusion',
      'acknowledgements',
      'references'
    ])
    // Abstract moves to the front; the two sections nobody reads are marked, not deleted.
    expect(plan.items[0]?.entry.title).toBe('Abstract')
    expect(plan.items.at(-1)?.action).toBe('skip')
    expect(summarizeReadingOrder(plan)).toEqual({ read: 6, skim: 0, skip: 2 })
  })

  it('gives a subsection the role of the section it sits under', () => {
    const plan = planReadingOrder([
      entry('Methods', 2),
      entry('Cell lines', 3, 2),
      entry('Sequencing', 4, 2),
      entry('Results', 6)
    ])

    const cellLines = plan.items.find((item) => item.entry.title === 'Cell lines')
    expect(cellLines?.role).toBe('methods')
    // Inheritance, not promotion: the subsection stays after its parent, in print order.
    expect(plan.items.map((item) => item.entry.title)).toEqual([
      'Methods',
      'Cell lines',
      'Sequencing',
      'Results'
    ])
  })

  it('reads a Chinese outline the same way, and strips section numbering', () => {
    const plan = planReadingOrder([
      entry('1 引言', 1),
      entry('2 材料与方法', 2),
      entry('3 结果', 6),
      entry('4 讨论', 9),
      entry('5 参考文献', 12),
      entry('摘要', 1)
    ])

    expect(plan.items.map((item) => item.role)).toEqual([
      'abstract',
      'introduction',
      'methods',
      'results',
      'discussion',
      'references'
    ])
  })

  it('keeps an unrecognised section instead of dropping it, and puts it after the conclusion', () => {
    const plan = planReadingOrder([
      entry('Data availability', 20),
      entry('Results', 5),
      entry('Conclusion', 9)
    ])

    expect(plan.items.map((item) => item.entry.title)).toEqual([
      'Results',
      'Conclusion',
      'Data availability'
    ])
    expect(plan.items[2]?.action).toBe('read')
  })

  it('does not mistake a sentence that starts with a role word for a role', () => {
    // "Summary and outlook" is a conclusion; "Summary of patient characteristics" is a results table heading and
    // must not be lifted to the front of the plan.
    const plan = planReadingOrder([
      entry('Results', 4),
      entry('Summary of patient characteristics', 5, 2)
    ])

    expect(plan.items[1]?.role).toBe('results')
  })

  it('marks context and appendix as skim rather than read', () => {
    const plan = planReadingOrder([
      entry('Related work', 1),
      entry('Appendix A: derivations', 14),
      entry('Methods', 3)
    ])

    expect(summarizeReadingOrder(plan)).toEqual({ read: 1, skim: 2, skip: 0 })
  })

  it('says there is nothing to plan when the document declares no bookmarks', () => {
    expect(planReadingOrder([])).toEqual({ items: [], empty: 'no-outline' })
  })
})
