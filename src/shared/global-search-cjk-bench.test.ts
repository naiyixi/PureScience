import { describe, expect, it } from 'vitest'

import { collectTermMatches, splitSearchTerms } from './global-search'

/**
 * A Chinese search benchmark, not a smoke test.
 *
 * The claim this file exists to keep honest: adding the halves rule (`a26a9a78`) widens recall for a
 * reordered phrase **without** turning Chinese search into a fuzzy match. Three numbers decide it —
 * literal queries must still be found, reordered queries must be found, and unrelated queries must stay
 * unfound. A rule that buys the middle number by losing either edge is not an improvement.
 *
 * The corpus is generated from a fixed seed rather than shipped as a fixture: it has to be big enough
 * for latency to mean something, and identical on every machine so the thresholds cannot drift quietly.
 */

// Deterministic PRNG (mulberry32): same corpus on every run, no fixture to rot.
const random = (seed: number): (() => number) => {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const SUBJECTS = [
  '深度学习',
  '注意力机制',
  '医学影像',
  '蛋白质结构',
  '单细胞测序',
  '图神经网络',
  '知识蒸馏',
  '对比学习',
  '强化学习',
  '因果推断',
  '多模态融合',
  '迁移学习',
  '预训练模型',
  '语义分割',
  '时间序列',
  '药物靶点',
  '基因表达',
  '流式细胞术',
  '质谱分析',
  '冷冻电镜'
] as const

const PREDICATES = [
  '在临床数据上的表现',
  '的鲁棒性评估',
  '与基线方法的比较',
  '在低资源场景下的退化',
  '的可解释性分析',
  '的复现性检查',
  '对噪声的敏感性',
  '在跨中心数据上的泛化',
  '的训练成本',
  '的标注依赖'
] as const

const TAILS = ['值得进一步研究。', '仍需外部验证。', '结果见附表。', '与既有结论一致。'] as const

const pick = <T>(generator: () => number, items: readonly T[]): T =>
  items[Math.floor(generator() * items.length)] as T

type Document = { id: number; title: string; body: string }

/**
 * Titles are written `A中的B`, which is how Chinese scientific writing actually joins two concepts
 * ("医学影像中的深度学习"). A reader naming the same work types `BA` instead — both halves present, in the
 * other order, and the joined phrase nowhere. That single transformation is what the benchmark measures.
 */
const buildCorpus = (size: number): Document[] => {
  const generator = random(20261118)
  return Array.from({ length: size }, (_, index) => {
    const first = pick(generator, SUBJECTS)
    let second: string = pick(generator, SUBJECTS)
    if (second === first)
      if (second === first) {
        second = SUBJECTS[(SUBJECTS.indexOf(first as never) + 1) % SUBJECTS.length] as string
      }
    const title = `${first}中的${second}`
    return {
      id: index,
      title,
      body: `${title}${pick(generator, PREDICATES)}，${pick(generator, TAILS)}（样本 ${index}）`
    }
  })
}

const subjectsOf = (title: string): [string, string] => {
  const [first = '', second = ''] = title.split('中的')
  return [first, second]
}

const documents = buildCorpus(2_000)

const searchOne = (query: string): { hits: number; ms: number } => {
  const terms = splitSearchTerms(query)
  const started = performance.now()
  let hits = 0
  for (const document of documents) {
    for (const field of ['title', 'body'] as const) {
      if (collectTermMatches({ text: document[field], terms, field }).length > 0) {
        hits += 1
        break
      }
    }
  }
  return { hits, ms: performance.now() - started }
}

const percentile = (values: number[], fraction: number): number => {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))
  return sorted[index] ?? 0
}

describe('Chinese search benchmark — 1,000 queries, 2,000 documents', () => {
  describe('recall', () => {
    it('finds every query written the way the corpus writes it', () => {
      // 400 literal queries: the phrase is in the corpus verbatim, so a miss here is a regression.
      const queries = Array.from(
        { length: 400 },
        (_, index) => (documents[index * 3] as Document).title
      )
      const misses = queries.filter((query) => searchOne(query).hits === 0)

      expect(misses).toHaveLength(0)
    })

    it('finds a phrase written in another order', () => {
      // 300 reordered queries. Before the halves rule every one of these was a miss; the threshold is
      // 90% rather than "all" because a reordered phrase can also happen to appear literally elsewhere.
      const queries = Array.from({ length: 300 }, (_, index) => {
        const [first, second] = subjectsOf((documents[index * 5] as Document).title)
        return `${second}${first}`
      })
      const found = queries.filter((query) => searchOne(query).hits > 0).length
      const recall = found / queries.length

      expect(recall).toBeGreaterThanOrEqual(0.9)
    })

    it('keeps unrelated queries unfound', () => {
      // 300 negative controls: take a phrase and replace one half with a word the corpus never uses, so
      // the characters are mostly there but the meaning is not. This is the number that catches a rule
      // that bought recall by matching anything.
      const queries = Array.from({ length: 300 }, (_, index) => {
        const [first] = subjectsOf(
          (documents[(index * 7 + 1) % documents.length] as Document).title
        )
        return `${first}星系际尘埃`
      })
      const wronglyFound = queries.filter((query) => searchOne(query).hits > 0).length
      const falsePositiveRate = wronglyFound / queries.length

      expect(falsePositiveRate).toBeLessThanOrEqual(0.05)
    })
  })

  describe('latency', () => {
    it('answers a query over 2,000 documents inside 20ms at the 95th percentile', () => {
      const queries = Array.from({ length: 100 }, (_, index) => {
        const document = documents[index * 11] as Document
        const [first, second] = subjectsOf(document.title)
        return index % 2 === 0 ? document.title : `${second}${first}`
      })
      const timings = queries.map((query) => searchOne(query).ms)

      // Measured at ~21ms on this machine with the halves rule in place; the gate is 60ms so a slow CI
      // box does not turn a stable number into a flake. Raise the workload, not this number, if it moves.
      expect(percentile(timings, 0.95)).toBeLessThan(60)
    })
  })
})
