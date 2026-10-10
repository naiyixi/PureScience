import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Read-source tests for the Chinese term table.
//
// These do not test a behaviour of the normaliser so much as the DATA it ships: every row must be
// matchable, every spelling must resolve back to the row it belongs to, and the table must stay big
// enough to be the thing the connectors rely on. A row that no query can reach is a row that looks like
// coverage while providing none, which is the failure mode this file exists to catch.

import { describe, it, expect } from 'vitest'
import { hasCjkScript } from './citation/names'
import {
  CHINESE_TERMS,
  CHINESE_TERM_KINDS,
  normaliseTerm,
  planChineseQuery,
  rewriteChineseTermsInPlace,
  normaliseQueryPunctuation,
  type ChineseTermEntry
} from './chinese-terms'

const denoting = CHINESE_TERMS.filter((row) => row.kind !== 'connective')
const connectives = CHINESE_TERMS.filter((row) => row.kind === 'connective')
const everyKey = (row: (typeof CHINESE_TERMS)[number]): string[] => [
  row.canonical,
  ...(row.variants ?? [])
]

describe('the Chinese term table (read from source)', () => {
  it('covers every declared kind, with a table big enough to be load-bearing', () => {
    const byKind = Object.fromEntries(
      CHINESE_TERM_KINDS.map((kind) => [
        kind,
        CHINESE_TERMS.filter((row) => row.kind === kind).length
      ])
    )
    // Floors, not targets: they exist so a bad merge cannot quietly halve the table.
    expect(byKind.drug).toBeGreaterThanOrEqual(80)
    expect(byKind.indication).toBeGreaterThanOrEqual(80)
    expect(byKind.institution).toBeGreaterThanOrEqual(15)
    expect(byKind.journal).toBeGreaterThanOrEqual(17)
    expect(byKind.method).toBeGreaterThanOrEqual(25)
    expect(byKind.procedure).toBeGreaterThanOrEqual(18)
    expect(byKind.topic).toBeGreaterThanOrEqual(20)
    expect(byKind.connective).toBeGreaterThanOrEqual(10)
    expect(CHINESE_TERMS.length).toBeGreaterThanOrEqual(200)
    expect(
      byKind.drug +
        byKind.indication +
        byKind.institution +
        byKind.journal +
        byKind.method +
        byKind.procedure +
        byKind.topic
    ).toBe(denoting.length)
  })

  // The note is the other half of the record, so the two are cross-checked in BOTH directions: a row
  // missing from either side fails, and a row that disagrees on the English term or the descriptor
  // fails. Neither can drift alone. Shared by every kind that carries a source rather than copied, so a
  // new sourced kind cannot land with a weaker check than the ones beside it: the assertions are
  // identical by construction, not merely similar.
  const documentedPairs = (noteFile: string): Map<string, { english: string; source: string }> => {
    const note = readFileSync(join(__dirname, `../../docs/evidence/${noteFile}`), 'utf8')
    const documented = new Map<string, { english: string; source: string }>()
    // Padding-tolerant on purpose: the repo formats markdown, and a table formatter pads every cell, so
    // an exact-spacing parser would silently read four rows out of thirty and call the rest missing.
    // `mesh:D\d{6,}` in the third column is what marks a row as a documented pair, so the notes can
    // carry other tables (deliberate omissions, readings) without this parser collecting them.
    for (const match of note.matchAll(
      /^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*(mesh:D\d{6,})\s*\|\s*$/gm
    )) {
      documented.set(match[1].trim(), { english: match[2].trim(), source: match[3].trim() })
    }
    return documented
  }

  const expectRowsMatchNote = (
    rows: readonly ChineseTermEntry[],
    noteFile: string,
    floor: number
  ): void => {
    expect(rows.length).toBeGreaterThanOrEqual(floor)
    // An English side that was looked up rather than chosen must say where. Nothing here is inferred: a
    // sourced row without a MeSH descriptor would be a translation wearing an authority's clothes.
    for (const row of rows) {
      expect(row.source, `${row.canonical} has no source`).toMatch(/^mesh:D\d{6,}$/)
      expect(row.english.length).toBeGreaterThan(0)
    }
    const documented = documentedPairs(noteFile)
    expect(documented.size).toBe(rows.length)
    for (const row of rows) {
      const entry = documented.get(row.canonical)
      expect(entry, `${row.canonical} is not in the note`).toBeDefined()
      expect(entry?.english, `${row.canonical} disagrees on the English term`).toBe(row.english)
      expect(entry?.source, `${row.canonical} disagrees on the descriptor`).toBe(row.source)
    }
  }

  it('records where each method term came from, and matches the note that lists those pairs', () => {
    // Narrowed by predicate, not by assertion: `source` and `english` live on the denoting branch of the
    // table's union, and a cast would only have hidden that from the typechecker.
    expectRowsMatchNote(
      CHINESE_TERMS.filter((row): row is ChineseTermEntry => row.kind === 'method'),
      '2026-10-10-chinese-method-terms.md',
      25
    )
  })

  it('records where each procedure term came from, to the same standard as the method rows', () => {
    expectRowsMatchNote(
      CHINESE_TERMS.filter((row): row is ChineseTermEntry => row.kind === 'procedure'),
      '2026-10-10-chinese-procedure-terms.md',
      18
    )
  })

  it('records where each topic term came from, to the same standard as the method rows', () => {
    expectRowsMatchNote(
      CHINESE_TERMS.filter((row): row is ChineseTermEntry => row.kind === 'topic'),
      '2026-10-10-chinese-topic-terms.md',
      20
    )
  })

  it('writes every spelling so the normaliser can reach it, and every English term in Latin', () => {
    for (const row of CHINESE_TERMS) {
      // Reachability, not a character class: the matcher is only entered for text containing a Han
      // character (see planChineseQuery), so a spelling without one is an entry nothing can reach.
      expect(hasCjkScript(row.canonical), `canonical "${row.canonical}"`).toBe(true)
      for (const variant of row.variants ?? []) {
        expect(hasCjkScript(variant), `variant "${variant}" of "${row.canonical}"`).toBe(true)
      }
      if (row.kind === 'connective') continue
      expect(row.english.trim(), `english of "${row.canonical}"`).not.toBe('')
      expect(hasCjkScript(row.english), `english of "${row.canonical}" must stay Latin`).toBe(false)
    }
  })

  it('has no canonical spelling twice, and no spelling claimed by two rows', () => {
    const canonicals = CHINESE_TERMS.map((row) => row.canonical)
    expect(new Set(canonicals).size).toBe(canonicals.length)

    const owner = new Map<string, string>()
    const collisions: string[] = []
    for (const row of CHINESE_TERMS) {
      for (const key of everyKey(row)) {
        const seen = owner.get(key)
        if (seen && seen !== row.canonical) collisions.push(`"${key}": ${seen} vs ${row.canonical}`)
        owner.set(key, row.canonical)
      }
    }
    expect(collisions).toEqual([])
  })

  it('declares a variant only when it differs from the canonical spelling', () => {
    for (const row of CHINESE_TERMS) {
      expect(row.variants ?? [], `variants of "${row.canonical}"`).not.toContain(row.canonical)
    }
  })
})

describe('normaliseTerm: one term in, one term out, with what changed', () => {
  it('reports "already canonical" as zero substitutions rather than as a hit', () => {
    const result = normaliseTerm('阿司匹林')
    expect(result).toEqual({
      ok: true,
      raw: '阿司匹林',
      canonical: '阿司匹林',
      kind: 'drug',
      english: 'aspirin',
      substitutions: []
    })
  })

  it('names the substitution a variant underwent', () => {
    const result = normaliseTerm('扑热息痛')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.canonical).toBe('对乙酰氨基酚')
    expect(result.english).toBe('acetaminophen')
    expect(result.substitutions).toEqual([
      {
        from: '扑热息痛',
        to: '对乙酰氨基酚',
        entry: expect.objectContaining({ canonical: '对乙酰氨基酚', kind: 'drug' })
      }
    ])
  })

  it('resolves clinical abbreviations to the full spellings', () => {
    const infarct = normaliseTerm('心梗')
    expect(infarct.ok && infarct.canonical).toBe('心肌梗死')
    expect(infarct.ok && infarct.english).toBe('myocardial infarction')
    const copd = normaliseTerm('慢阻肺')
    expect(copd.ok && copd.canonical).toBe('慢性阻塞性肺疾病')
  })

  it('refuses by name instead of guessing at an unknown term', () => {
    expect(normaliseTerm('')).toMatchObject({ ok: false, reason: 'empty' })
    expect(normaliseTerm('aspirin')).toMatchObject({ ok: false, reason: 'no-chinese-terms' })
    expect(normaliseTerm('某个表里没有的病')).toMatchObject({ ok: false, reason: 'unknown-term' })
    const refusal = normaliseTerm('某个表里没有的病')
    expect(refusal.ok === false && refusal.detail).toContain('某个表里没有的病')
  })

  it('says a function word is a function word, not an unknown term', () => {
    const refusal = normaliseTerm('的')
    expect(refusal).toMatchObject({ ok: false, reason: 'unknown-term' })
    expect(refusal.ok === false && refusal.detail).toContain('function word')
  })
})

describe('every row in the table is reachable', () => {
  it('rewrites each canonical spelling to its English term of record, with nothing left over', () => {
    for (const row of denoting) {
      const plan = planChineseQuery(row.canonical)
      expect(plan.cjk, `"${row.canonical}" was not detected as Chinese`).toBe(true)
      expect(plan.unmapped, `"${row.canonical}" left text unmapped`).toEqual([])
      expect(plan.query, `"${row.canonical}" did not rewrite to its English term`).toBe(row.english)
      expect(plan.applied.map((s) => s.to)).toEqual([row.canonical])
    }
  })

  it('resolves each declared variant back to its own row', () => {
    for (const row of denoting) {
      for (const variant of row.variants ?? []) {
        const result = normaliseTerm(variant)
        expect(result.ok, `"${variant}" did not resolve`).toBe(true)
        if (!result.ok) continue
        expect(result.canonical, `"${variant}" resolved to the wrong row`).toBe(row.canonical)
        expect(result.substitutions.map((s) => s.from)).toEqual([variant])
      }
    }
  })

  it('removes every connective from a query rather than resolving it to a term', () => {
    for (const row of connectives) {
      for (const key of everyKey(row)) {
        const plan = planChineseQuery(key)
        expect(plan.cjk).toBe(true)
        expect(plan.query, `"${key}" should leave nothing behind`).toBe('')
        expect(plan.unmapped, `"${key}" should be accounted for`).toEqual([])
      }
    }
  })

  it('picks the longest match, so a compound term never leaves its head word behind', () => {
    expect(planChineseQuery('非小细胞肺癌').query).toBe('non-small cell lung cancer')
    expect(planChineseQuery('低分子肝素').query).toBe('low molecular weight heparin')
    expect(planChineseQuery('急性髓系白血病').query).toBe('acute myeloid leukemia')
    expect(planChineseQuery('高血压病').query).toBe('hypertension')
  })

  it('rewrites in place, so a field prefix stays attached to the term it applies to', () => {
    // The composed plan joins its pieces with spaces, which would turn `ti:阿司匹林` into `ti: aspirin` —
    // a different question. In-place rewriting leaves everything but the term alone.
    expect(rewriteChineseTermsInPlace('ti:阿司匹林').query).toBe('ti:aspirin')
    expect(rewriteChineseTermsInPlace('all:阿司匹林 AND au:Smith').query).toBe(
      'all:aspirin AND au:Smith'
    )
    // A function word becomes the space it stood for, so the two terms never fuse into one token.
    expect(rewriteChineseTermsInPlace('阿司匹林治疗高血压').query).toBe('aspirin hypertension')
    // And it names what it could not reach, exactly like the plan does.
    const gap = rewriteChineseTermsInPlace('all:阿司匹林 OR 量子纠缠')
    expect(gap.unmapped).toEqual(['量子纠缠'])
    expect(gap.query).toBe('all:aspirin OR 量子纠缠')
  })

  it('keeps unaccounted-for Chinese only when the caller asks for it, naming it either way', () => {
    // The default is the mapped question ONLY, so `query` can never pass for the whole question — which
    // is what a caller that refuses by name needs.
    const refuse = planChineseQuery('阿司匹林用于量子纠缠')
    expect(refuse.unmapped).toEqual(['量子纠缠'])
    expect(refuse.query).toBe('aspirin')

    // `keep` is for a caller whose source answers Chinese (measured per source): dropping the run would
    // remove a search that works, so it stays as typed and the caller reports it.
    const keep = planChineseQuery('阿司匹林用于量子纠缠', { unmapped: 'keep' })
    expect(keep.unmapped).toEqual(['量子纠缠'])
    expect(keep.query).toBe('aspirin 量子纠缠')
  })
})

describe('planChineseQuery: whole queries', () => {
  it('leaves a Latin query untouched and says it was not Chinese', () => {
    expect(planChineseQuery('CRISPR gene editing')).toEqual({
      cjk: false,
      applied: [],
      query: 'CRISPR gene editing',
      unmapped: []
    })
  })

  it('rewrites a mixed query and keeps the Latin words it was given', () => {
    const plan = planChineseQuery('阿司匹林 aspirin 二级预防')
    expect(plan.query).toBe('aspirin aspirin')
    expect(plan.unmapped).toEqual(['二级预防'])
    expect(plan.applied.map((s) => s.from)).toEqual(['阿司匹林'])
  })

  it('treats Chinese sentence punctuation as a separator, not as part of a term', () => {
    expect(normaliseQueryPunctuation('阿司匹林，高血压。')).toBe('阿司匹林 高血压')
    expect(planChineseQuery('阿司匹林，高血压').query).toBe('aspirin hypertension')
  })

  it('drops function words from the query it would send', () => {
    expect(planChineseQuery('阿司匹林治疗高血压').query).toBe('aspirin hypertension')
    expect(planChineseQuery('阿司匹林和高血压的比较').query).toBe('aspirin hypertension')
    expect(planChineseQuery('阿司匹林对高血压').query).toBe('aspirin hypertension')
  })

  it('names what it could not map instead of dropping it silently', () => {
    const plan = planChineseQuery('阿司匹林用于晚期肺癌')
    expect(plan.unmapped).toEqual(['晚期'])
    // The mapped part is still offered, so the caller can see how much of the question survived.
    expect(plan.query).toBe('aspirin lung cancer')
    expect(plan.applied.map((s) => s.from)).toEqual(['阿司匹林', '用于', '肺癌'])
  })

  it('reports an unknown Chinese run as the whole gap', () => {
    expect(planChineseQuery('肾病').unmapped).toEqual(['肾病'])
    expect(planChineseQuery('肾病').query).toBe('')
    expect(planChineseQuery('阿司匹林 肾病').unmapped).toEqual(['肾病'])
  })
})
