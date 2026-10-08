import { describe, expect, it, vi } from 'vitest'

import { ParserEngine } from '../engine'
import type { ToolContext } from '../types'

import { ZH_MEDICAL_TERMS_TOOLS, normaliseZhTerm, parseQid } from './zh-medical-terms'

const tool = (id: string): (typeof ZH_MEDICAL_TERMS_TOOLS)[number] => {
  const found = ZH_MEDICAL_TERMS_TOOLS.find((candidate) => candidate.id === id)
  if (!found || !found.run) throw new Error(`descriptor ${id} is missing or has no run()`)
  return found
}

// A context whose fetchJson records every URL and answers from a scripted list of bodies.
const ctxWith = (bodies: unknown[]): { ctx: ToolContext; urls: string[] } => {
  const urls: string[] = []
  const fetchJson = vi.fn(async (url: string) => {
    urls.push(url)
    const next = bodies.shift()
    if (next instanceof Error) throw next
    return next
  })
  return {
    ctx: { fetchJson, fetchText: vi.fn(), credentials: {} } as unknown as ToolContext,
    urls
  }
}

// The shapes these two tools return, spelled out so the assertions are typed — a field rename in the
// descriptor then fails here instead of being hidden behind `any`.
type ResolveResult = {
  query: {
    input: string
    normalised: string
    normalisation_steps: string[]
    stripped_dosage_form: string | null
    sent: string
    fallback: { used: boolean; sent: string | null; reason: string | null }
  }
  candidates: Array<{
    qid: string
    label: string | null
    description: string | null
    matched: { field: string; language: string; text: string }
    entity_url: string
  }>
  candidate_count: number
  ambiguity: { multiple_candidates: boolean; ranked_by: string | null; note: string | null }
  notes: string[]
}

type CrosswalkResult = {
  qid: string
  labels: Record<string, string | null>
  aliases: Record<string, string[]>
  missing: string[]
  wikipedia: {
    zhwiki: { title: string | null; url: string | null }
    enwiki: { title: string | null; url: string | null }
  }
  provenance: { entity_url: string; last_revision_id: number | null; license: string }
  notes: string[]
}

const searchBody = (
  hits: { id: string; label?: string; description?: string; type?: string; language?: string }[]
): unknown => ({
  search: hits.map((hit) => ({
    id: hit.id,
    label: hit.label,
    description: hit.description,
    match: { type: hit.type ?? 'label', language: hit.language ?? 'zh', text: hit.label }
  })),
  searchinfo: { search: 'x' },
  success: 1
})

describe('normaliseZhTerm', () => {
  it('strips a trailing dosage form and says which one, so 阿司匹林肠溶片 can still resolve', () => {
    const normalised = normaliseZhTerm('阿司匹林肠溶片')
    expect(normalised.sent).toBe('阿司匹林')
    expect(normalised.strippedDosageForm).toBe('肠溶片')
    expect(normalised.steps).toEqual(['stripped the dosage-form suffix "肠溶片"'])
  })

  it('prefers the longest dosage form (肠溶片 over 片) and never strips a one-character core', () => {
    expect(normaliseZhTerm('二甲双胍片').sent).toBe('二甲双胍')
    // "片" alone would be stripped to nothing — it is left as it is.
    expect(normaliseZhTerm('片')).toMatchObject({ sent: '片', strippedDosageForm: null })
    expect(normaliseZhTerm('药片')).toMatchObject({ sent: '药片', strippedDosageForm: null })
  })

  it('folds full-width characters, trims and collapses whitespace, and reports each step', () => {
    const normalised = normaliseZhTerm('  Ａｓｐｉｒｉｎ\u3000 阿司匹林  ')
    expect(normalised.sent).toBe('Aspirin 阿司匹林')
    expect(normalised.steps).toEqual([
      'trimmed surrounding whitespace',
      'collapsed internal whitespace runs',
      'folded full-width characters to half-width'
    ])
  })

  it('reports no steps for a term that needs no normalisation', () => {
    expect(normaliseZhTerm('二甲双胍')).toMatchObject({ sent: '二甲双胍', steps: [] })
  })
})

describe('zh_term_resolve', () => {
  it('returns every ranked candidate with the field it matched on instead of collapsing them', async () => {
    const { ctx, urls } = ctxWith([
      searchBody([
        {
          id: 'Q356033',
          label: '腺癌',
          description: 'carcinoma that has material basis in abnormal…',
          type: 'alias',
          language: 'zh'
        },
        {
          id: 'Q3658562',
          label: '非小細胞肺癌',
          description: 'any type of epithelial lung cancer',
          type: 'label'
        }
      ])
    ])
    const result = (await tool('zh_term_resolve').run!(ctx, {
      term: '非小细胞肺癌'
    })) as ResolveResult

    expect(result.candidate_count).toBe(2)
    expect(result.candidates.map((candidate: { qid: string }) => candidate.qid)).toEqual([
      'Q356033',
      'Q3658562'
    ])
    expect(result.candidates[0].matched).toEqual({ field: 'alias', language: 'zh', text: '腺癌' })
    expect(result.candidates[1].entity_url).toBe('https://www.wikidata.org/entity/Q3658562')
    expect(result.ambiguity.multiple_candidates).toBe(true)
    expect(String(result.ambiguity.note)).toContain('not a resolution')
    expect(urls).toHaveLength(1)
    expect(urls[0]).toContain('wbsearchentities')
    expect(decodeURIComponent(urls[0]!)).toContain('search=非小细胞肺癌')
  })

  it('sends the normalised query and reports the steps, then retries the term as given once', async () => {
    const { ctx, urls } = ctxWith([
      searchBody([]), // 阿司匹林 (after stripping 肠溶片) — scripted as a miss for this case
      searchBody([{ id: 'Q18216', label: '阿司匹林' }])
    ])
    const result = (await tool('zh_term_resolve').run!(ctx, {
      term: '阿司匹林肠溶片'
    })) as ResolveResult

    expect(urls).toHaveLength(2)
    expect(decodeURIComponent(urls[0]!)).toContain('search=阿司匹林&')
    expect(decodeURIComponent(urls[1]!)).toContain('search=阿司匹林肠溶片')
    expect(result.query.normalisation_steps).toEqual(['stripped the dosage-form suffix "肠溶片"'])
    expect(result.query.fallback.used).toBe(true)
    expect(result.query.sent).toBe('阿司匹林肠溶片')
    expect(result.candidate_count).toBe(1)
  })

  it('reports a miss as "not found in Wikidata", quoting the query, and does not call it absent', async () => {
    const { ctx } = ctxWith([searchBody([]), searchBody([])])
    const result = (await tool('zh_term_resolve').run!(ctx, {
      term: '拜阿司匹灵'
    })) as ResolveResult

    expect(result.candidate_count).toBe(0)
    expect(result.candidates).toEqual([])
    expect(result.query.fallback.used).toBe(false)
    expect(result.notes.join(' ')).toContain('matched no Wikidata entity')
    expect(result.notes.join(' ')).toContain('NOT the same statement as')
  })

  it('sends a term that needs no normalisation exactly once', async () => {
    const { ctx, urls } = ctxWith([searchBody([{ id: 'Q19484', label: '二甲双胍' }])])
    const result = (await tool('zh_term_resolve').run!(ctx, { term: '二甲双胍' })) as ResolveResult

    expect(urls).toHaveLength(1)
    expect(result.ambiguity.multiple_candidates).toBe(false)
    expect(result.candidate_count).toBe(1)
  })

  it('refuses an unreadable body instead of reading it as "no match"', async () => {
    const { ctx } = ctxWith([{ unexpected: true }])
    await expect(tool('zh_term_resolve').run!(ctx, { term: '阿司匹林' })).rejects.toThrow(
      /without a `search` array/
    )
  })

  it('refuses an empty term before any request is sent', async () => {
    const { ctx, urls } = ctxWith([])
    await expect(tool('zh_term_resolve').run!(ctx, { term: '   ' })).rejects.toThrow(
      /nothing was queried/
    )
    expect(urls).toEqual([])
  })
})

describe('zh_term_crosswalk', () => {
  const entity = (overrides: Record<string, unknown> = {}): unknown => ({
    entities: {
      Q10420388: {
        id: 'Q10420388',
        labels: {
          en: { language: 'en', value: 'Aspirin' },
          zh: { language: 'zh', value: '阿斯匹靈' }
        },
        descriptions: {
          en: { language: 'en', value: 'trade name for Bayer Aspirin and many others' }
        },
        aliases: { en: [{ language: 'en', value: 'Bayer Aspirin' }] },
        sitelinks: {
          zhwiki: {
            site: 'zhwiki',
            title: '阿斯匹靈',
            url: 'https://zh.wikipedia.org/wiki/%E9%98%BF'
          }
        },
        lastrevid: 2538572110,
        ...overrides
      }
    }
  })

  it('reads the labels, aliases and sitelinks, and names the languages that carry none', async () => {
    const { ctx, urls } = ctxWith([entity()])
    const result = (await tool('zh_term_crosswalk').run!(ctx, {
      qid: 'q10420388'
    })) as CrosswalkResult

    expect(urls[0]).toContain('wbgetentities')
    expect(urls[0]).toContain('sitelinks%2Furls')
    expect(result.qid).toBe('Q10420388')
    expect(result.labels.en).toBe('Aspirin')
    expect(result.labels.zh).toBe('阿斯匹靈')
    expect(result.aliases.en).toEqual(['Bayer Aspirin'])
    expect(result.missing).toContain('zh-hant label')
    expect(result.missing).toContain('zh aliases')
    expect(result.wikipedia.zhwiki.url).toBe('https://zh.wikipedia.org/wiki/%E9%98%BF')
    expect(result.provenance).toMatchObject({
      entity_url: 'https://www.wikidata.org/entity/Q10420388',
      last_revision_id: 2538572110
    })
    expect(result.notes.join(' ')).toContain('zh-hant label')
  })

  it('refuses by name when the service answers 200 with a no-such-entity error', async () => {
    const { ctx } = ctxWith([
      {
        error: {
          code: 'no-such-entity',
          info: 'Could not find an entity with the ID "Q999999999999".'
        }
      }
    ])
    await expect(tool('zh_term_crosswalk').run!(ctx, { qid: 'Q999999999999' })).rejects.toThrow(
      /does not know Q999999999999/
    )
  })

  it('refuses an answer that carries no entity rather than reporting null labels', async () => {
    const { ctx } = ctxWith([{ entities: {} }])
    await expect(tool('zh_term_crosswalk').run!(ctx, { qid: 'Q18216' })).rejects.toThrow(
      /carried no entity/
    )
  })

  it('refuses an id that is not a QID before any request is sent', async () => {
    const { ctx, urls } = ctxWith([])
    await expect(tool('zh_term_crosswalk').run!(ctx, { qid: '阿司匹林' })).rejects.toThrow(
      /nothing was fetched/
    )
    expect(urls).toEqual([])
  })
})

describe('parseQid', () => {
  it('accepts a bare QID, either case, and the entity/wiki URL forms', () => {
    expect(parseQid('Q18216')).toBe('Q18216')
    expect(parseQid(' q18216 ')).toBe('Q18216')
    expect(parseQid('https://www.wikidata.org/entity/Q18216')).toBe('Q18216')
    expect(parseQid('https://www.wikidata.org/wiki/Q18216')).toBe('Q18216')
  })

  it('refuses property ids and free text', () => {
    for (const bad of ['P123', 'Q', '18216', 'Q18x16']) {
      expect(() => parseQid(bad)).toThrow(/is not one/)
    }
  })
})

// Live smoke test against the real service — opt in with LIVE_API=1 (the same convention the other
// descriptors use). It runs the descriptor's OWN run() through the app's engine, so a wrong URL shape or
// a mis-read `match` field fails here even though the mocked cases above would still pass.
describe.skipIf(!process.env.LIVE_API)('zh_medical_terms / LIVE', () => {
  const live = new ParserEngine()
  const call = (id: string, args: Record<string, unknown>): Promise<unknown> =>
    live.call(tool(id), args, {})

  it('resolves 二甲双胍 and carries it to the English label the other connectors index', async () => {
    const resolved = (await call('zh_term_resolve', { term: '二甲双胍' })) as {
      candidates: Array<{ qid: string; label: string | null; matched: { field: string } }>
      candidate_count: number
    }
    expect(resolved.candidate_count).toBeGreaterThan(0)
    const top = resolved.candidates[0]!
    expect(top.qid).toBe('Q19484')
    expect(top.label).toBe('二甲双胍')

    const crosswalk = (await call('zh_term_crosswalk', { qid: top.qid })) as {
      labels: Record<string, string | null>
      aliases: Record<string, string[]>
    }
    expect(crosswalk.labels.en).toBe('metformin')
    expect(crosswalk.aliases.zh).toContain('每福敏')
  }, 60000)

  it('strips a dosage form and still finds the drug it names', async () => {
    const resolved = (await call('zh_term_resolve', { term: '阿司匹林肠溶片' })) as {
      query: { normalisation_steps: string[]; stripped_dosage_form: string | null }
      candidates: Array<{ qid: string }>
    }
    expect(resolved.query.stripped_dosage_form).toBe('肠溶片')
    expect(resolved.query.normalisation_steps).toContain('stripped the dosage-form suffix "肠溶片"')
    expect(resolved.candidates.map((candidate) => candidate.qid)).toContain('Q18216')
  }, 60000)

  it('reports a term it cannot find as not-found rather than as a term that does not exist', async () => {
    const resolved = (await call('zh_term_resolve', { term: '完全不存在的词条XYZ' })) as {
      candidate_count: number
      notes: string[]
    }
    expect(resolved.candidate_count).toBe(0)
    expect(resolved.notes.join(' ')).toContain('matched no Wikidata entity')
  }, 60000)
})
