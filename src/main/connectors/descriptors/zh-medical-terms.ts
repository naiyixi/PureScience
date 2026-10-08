// Chinese medical wording, carried onto a citable identity — Wikidata as the cross-lingual index.
//
// Protocol proven against the live service before this file was written (2026-10-08), readings kept:
//   GET wbsearchentities?search=阿司匹林&language=zh&uselang=zh&limit=3&type=item
//       -> 200, 3 hits, top = Q18216 阿司匹林 (match {type:'label', language:'zh'})
//   GET wbsearchentities?search=阿斯匹灵 (a traditional/alias spelling)
//       -> 200, 1 hit, Q18216, match {type:'alias', language:'zh', text:'阿斯匹灵'}   (aliases DO match)
//   GET wbsearchentities?search=非小细胞肺癌
//       -> 200, 3 hits, rank 1 = Q356033 腺癌 (matched as an ALIAS), rank 2 = Q3658562 非小细胞肺癌
//   GET wbsearchentities?search=乙肝
//       -> 200, 3 hits, rank 1 = Q3144978 乙肝歧视 (unrelated); the disease itself is Q6853 乙型肝炎
//   GET wbsearchentities?search=阿司匹林肠溶片            -> 200, 0 hits (a dosage form defeats the search)
//   GET wbsearchentities?search=拜阿司匹灵 (a brand name)  -> 200, 0 hits
//   GET wbsearchentities?search=完全不存在的词条XYZ        -> 200, {"search":[],"searchinfo":{...},"success":1}
//   GET wbgetentities?ids=Q999999999999&props=labels      -> HTTP 200 with {"error":{"code":"no-such-entity",…}}
//   GET wbgetentities?ids=Q18216&props=…|sitelinks/urls   -> 200, sitelinks carry title AND url; lastrevid 2538572110
//   repeated GETs at ~0.4s spacing                          -> HTTP 429 Too Many Requests
//   a few GETs of wbgetentities                             -> SSL handshake timeout (intermittent, this network)
// Consequences baked into these tools:
//   * The service's ranking is NOT a resolution. Two of the six Chinese terms above put an unrelated
//     entity first, so `zh_term_resolve` returns the ranked candidates with the field each one matched
//     on and NEVER collapses them into one answer — picking rank 1 silently is how a normaliser ends up
//     asserting something the source never said.
//   * Dosage-form suffixes and brand names make the search miss entirely, so the query is normalised
//     first (full-width folding, whitespace, a trailing dosage form), the steps applied are reported,
//     and a normalised miss is retried ONCE with the term exactly as given — normalisation is allowed
//     to add hits, never to remove them.
//   * A miss is a miss: it is reported as "not found in Wikidata", never as "no such term" — Wikidata is
//     community-maintained and its search is literal.
//   * wbgetentities answers 200 with an `error` object for an id it does not know, so a parser that only
//     reads `entities` would return a crosswalk of nulls that looks like a verified reading.
//
// Scope, so that no second vocabulary grows next to this one: a curated canonical-Chinese → English
// table for the terms the app already knows belongs to the shared layer (one table, one spelling of
// record). This connector deliberately ships NO term table — it answers the other half of the question:
// what a term the app has never seen resolves to, which entity it is, and where that reading came from.
import type { ToolContext, ToolDescriptor } from '../types'

const BASE = 'https://www.wikidata.org/w/api.php'
const entityUrl = (qid: string): string => `https://www.wikidata.org/entity/${qid}`
const LICENSE = 'CC0 1.0 (Wikidata makes its data available under a public-domain dedication)'

const MISS_NOTE =
  'This query matched no Wikidata entity. That is NOT the same statement as "this term does not ' +
  'exist": Wikidata is community-maintained and its search is literal, so a brand name, a term with a ' +
  'dosage form attached, or an uncommon Chinese spelling may simply be absent from its labels and ' +
  'aliases. Report it as "not found in Wikidata", and say which query was sent.'

// Longest-first: "肠溶片" must win over "片", otherwise the stripped core keeps the 肠溶 part.
const DOSAGE_FORMS = [
  '肠溶片',
  '缓释片',
  '控释片',
  '分散片',
  '咀嚼片',
  '泡腾片',
  '薄膜衣片',
  '软胶囊',
  '胶囊',
  '颗粒',
  '口服液',
  '注射液',
  '注射剂',
  '滴眼液',
  '喷雾剂',
  '气雾剂',
  '软膏',
  '乳膏',
  '凝胶剂',
  '凝胶',
  '糖浆',
  '混悬液',
  '栓剂',
  '滴剂',
  '片',
  '栓',
  '贴'
]

export type ZhTermNormalisation = {
  input: string
  sent: string
  steps: string[]
  strippedDosageForm: string | null
}

// U+FF01–U+FF5E are the full-width forms of ASCII; U+3000 is the ideographic space. A query typed on a
// Chinese IME can be full-width without the user noticing, and the service treats the two differently.
const foldFullWidth = (value: string): string =>
  value.replace(/[\uFF01-\uFF5E\u3000]/g, (char) => {
    const code = char.codePointAt(0)!
    if (code === 0x3000) return ' '
    return String.fromCharCode(code - 0xfee0)
  })

export const normaliseZhTerm = (raw: unknown): ZhTermNormalisation => {
  const input = String(raw ?? '')
  const steps: string[] = []
  let value = input
  const trimmed = value.trim()
  if (trimmed !== value) {
    steps.push('trimmed surrounding whitespace')
    value = trimmed
  }
  const collapsed = value.replace(/\s+/g, ' ')
  if (collapsed !== value) {
    steps.push('collapsed internal whitespace runs')
    value = collapsed
  }
  const folded = foldFullWidth(value)
  if (folded !== value) {
    steps.push('folded full-width characters to half-width')
    value = folded
  }
  let strippedDosageForm: string | null = null
  for (const form of DOSAGE_FORMS) {
    if (!value.endsWith(form)) continue
    const core = value.slice(0, value.length - form.length).trim()
    // "片" on its own, or a one-character core, is left alone: stripping it would send nothing.
    if (core.length < 2) break
    strippedDosageForm = form
    value = core
    steps.push(`stripped the dosage-form suffix "${form}"`)
    break
  }
  return { input, sent: value, steps, strippedDosageForm }
}

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

const text = (value: unknown): string | null => {
  if (value === null || value === undefined) return null
  const trimmed = String(value).trim()
  return trimmed.length > 0 ? trimmed : null
}

const clampLimit = (raw: unknown): number => {
  const n = Number(raw)
  if (!Number.isFinite(n)) return 5
  return Math.min(20, Math.max(1, Math.trunc(n)))
}

const searchUrl = (query: string, limit: number): string => {
  const params = new URLSearchParams({
    action: 'wbsearchentities',
    search: query,
    language: 'zh',
    uselang: 'zh',
    limit: String(limit),
    type: 'item',
    format: 'json'
  })
  return `${BASE}?${params.toString()}`
}

type Candidate = {
  qid: string
  label: string | null
  description: string | null
  matched: { field: string; language: string; text: string }
  entity_url: string
}

// The service answers {search:[…], searchinfo, success}. A body that is not that shape is reported as an
// unreadable response rather than silently read as "no candidates".
const candidatesFrom = (raw: unknown): Candidate[] => {
  const payload = asRecord(raw)
  if (!Array.isArray(payload.search)) {
    throw new Error(
      'Wikidata returned a body without a `search` array, so this response could not be read as a ' +
        'candidate list; nothing is being reported as "no match".'
    )
  }
  return payload.search.map((entry) => {
    const hit = asRecord(entry)
    const match = asRecord(hit.match)
    const qid = text(hit.id) ?? ''
    return {
      qid,
      label: text(hit.label),
      description: text(hit.description),
      matched: {
        field: text(match.type) ?? 'unknown',
        language: text(match.language) ?? 'unknown',
        text: text(match.text) ?? ''
      },
      entity_url: qid ? entityUrl(qid) : ''
    }
  })
}

// The search API carries no sitelink, so the Wikipedia link is filled in only when the caller asked for
// the crosswalk (zh_term_crosswalk), where the sitelink URL comes from the service itself.
const searchCandidates = async (
  ctx: ToolContext,
  query: string,
  limit: number
): Promise<Candidate[]> => {
  const raw = await ctx.fetchJson(searchUrl(query, limit))
  return candidatesFrom(raw)
}

const crosswalkUrl = (qid: string): string => {
  const params = new URLSearchParams({
    action: 'wbgetentities',
    ids: qid,
    props: 'labels|aliases|descriptions|sitelinks|sitelinks/urls|info',
    languages: 'zh|zh-hans|zh-hant|en',
    sitefilter: 'zhwiki|enwiki',
    format: 'json'
  })
  return `${BASE}?${params.toString()}`
}

const LANGUAGES = ['zh', 'zh-hans', 'zh-hant', 'en'] as const

const QID_PATTERN = /^(?:https?:\/\/www\.wikidata\.org\/(?:entity|wiki)\/)?([Qq]\d{1,12})$/

export const parseQid = (raw: unknown): string => {
  const value = String(raw ?? '').trim()
  const match = QID_PATTERN.exec(value)
  if (!match) {
    throw new Error(
      `Pass a Wikidata QID such as "Q18216" (an entity URL is accepted too). "${value}" is not one, ` +
        'so nothing was fetched.'
    )
  }
  return match[1]!.toUpperCase()
}

const languageMap = (raw: unknown): Record<string, string | null> => {
  const source = asRecord(raw)
  const out: Record<string, string | null> = {}
  for (const language of LANGUAGES) out[language] = text(asRecord(source[language]).value)
  return out
}

const aliasMap = (raw: unknown): Record<string, string[]> => {
  const source = asRecord(raw)
  const out: Record<string, string[]> = {}
  for (const language of LANGUAGES) {
    const entries = source[language]
    out[language] = Array.isArray(entries)
      ? entries
          .map((entry) => text(asRecord(entry).value))
          .filter((value): value is string => value !== null)
      : []
  }
  return out
}

export const ZH_MEDICAL_TERMS_TOOLS: ToolDescriptor[] = [
  {
    id: 'zh_term_resolve',
    connector: 'zh_medical_terms',
    description:
      'Resolve Chinese medical wording (a drug, a disease, an indication, an institution) onto a ' +
      'citable identity: Chinese medical vocabulary is not the vocabulary the literature and ' +
      'chemistry connectors index, so a Chinese term has to be carried onto something that is. ' +
      'Give a term in Chinese — traditional or simplified spellings and known aliases are matched, ' +
      'and a trailing dosage form ("阿司匹林肠溶片") is stripped, with every step that was applied ' +
      'reported back. Returns the SERVICE-RANKED candidates with the field each one matched on ' +
      '(label or alias) and a link to the entity; it never picks one for you, because the ranking is ' +
      'not a resolution — 非小细胞肺癌 and 乙肝 both rank an unrelated entity first. A query that ' +
      'matches nothing is reported as "not found in Wikidata" (with the query that was sent), not as ' +
      '"no such term". Feed a QID to zh_term_crosswalk to get the English label the other connectors ' +
      'answer to.',
    input: {
      type: 'object',
      properties: {
        term: {
          type: 'string',
          description:
            'Chinese term to resolve, e.g. "阿司匹林", "二甲双胍", "非小细胞肺癌", "北京协和医院".'
        },
        limit: {
          type: 'number',
          description:
            'How many ranked candidates to return (1–20, default 5). More than one is normal.'
        }
      }
    },
    required: ['term'],
    returns:
      '{query:{input, normalised, normalisation_steps:[…], sent, fallback:{used, sent, reason}}, ' +
      'candidates:[{qid, label, description, matched:{field:"label"|"alias", language, text}, ' +
      'entity_url}], candidate_count, ambiguity{…}, source:{name:"Wikidata", license:"CC0 1.0"}, notes:[…]}',
    example:
      'const resolved = await host.mcp("zh_medical_terms", "zh_term_resolve", {"term": "二甲双胍"})',
    run: async (ctx, args) => {
      const term = String(args.term ?? '').trim()
      if (term.length === 0) {
        throw new Error('Pass the Chinese term to resolve; nothing was queried.')
      }
      const limit = clampLimit(args.limit)
      const normalised = normaliseZhTerm(term)
      const notes: string[] = []

      let sent = normalised.sent
      let candidates = await searchCandidates(ctx, sent, limit)
      const fallback: { used: boolean; sent: string | null; reason: string | null } = {
        used: false,
        sent: null,
        reason: null
      }
      if (candidates.length === 0 && normalised.sent !== normalised.input) {
        // Normalisation may add hits, never remove them: the term as given gets one retry.
        const rawCandidates = await searchCandidates(ctx, normalised.input, limit)
        fallback.sent = normalised.input
        if (rawCandidates.length > 0) {
          candidates = rawCandidates
          sent = normalised.input
          fallback.used = true
          fallback.reason =
            'the normalised query returned nothing, so the term was sent exactly as given and that ' +
            'query is the one these candidates came from'
        } else {
          fallback.reason = 'the term exactly as given returned nothing either'
        }
      }

      if (candidates.length === 0) notes.push(MISS_NOTE)
      const ambiguity =
        candidates.length > 1
          ? {
              multiple_candidates: true,
              ranked_by: 'the service',
              note:
                "More than one entity matched. The ranking is the service's, not a resolution — read " +
                '`matched.field` (label vs alias) and the description before reusing a QID.'
            }
          : { multiple_candidates: false, ranked_by: null, note: null }

      return {
        query: {
          input: normalised.input,
          normalised: normalised.sent,
          normalisation_steps: normalised.steps,
          stripped_dosage_form: normalised.strippedDosageForm,
          sent,
          fallback
        },
        candidates,
        candidate_count: candidates.length,
        ambiguity,
        source: {
          name: 'Wikidata',
          license: LICENSE,
          api: searchUrl(sent, limit),
          entity_url_template: 'https://www.wikidata.org/entity/{qid}'
        },
        notes
      }
    }
  },
  {
    id: 'zh_term_crosswalk',
    connector: 'zh_medical_terms',
    description:
      'Read the identity behind a QID from zh_term_resolve: its Chinese labels (zh, zh-hans, ' +
      'zh-hant), its Chinese aliases, and its ENGLISH label and description — the wording the ' +
      'English-language connectors (PubMed, OpenAlex, PubChem, ChEMBL, clinical trials) actually ' +
      'index — plus its Chinese and English Wikipedia sitelinks. Use it to carry a Chinese term onto ' +
      'a query the other connectors can answer, and to cite where the mapping came from (entity URL ' +
      'and the revision id the labels were read at). A language that carries no label is listed under ' +
      '`missing` — Wikidata simply has no label in that variant, which is not a statement about the ' +
      'term; an id the service does not know is refused by name (it answers HTTP 200 with an error ' +
      'object, so an unguarded read would return nulls that look verified).',
    input: {
      type: 'object',
      properties: {
        qid: {
          type: 'string',
          description:
            'Wikidata entity id from zh_term_resolve, e.g. "Q18216" (entity URL accepted).'
        }
      }
    },
    required: ['qid'],
    returns:
      '{qid, labels:{zh, "zh-hans", "zh-hant", en}, aliases:{…:[…]}, descriptions:{…}, ' +
      'missing:["zh-hant label", …], wikipedia:{zhwiki:{title,url}, enwiki:{title,url}}, ' +
      'provenance:{entity_url, last_revision_id, api, license}, notes:[…]}',
    example:
      'const crosswalk = await host.mcp("zh_medical_terms", "zh_term_crosswalk", {"qid": "Q18216"})',
    run: async (ctx, args) => {
      const qid = parseQid(args.qid)
      const url = crosswalkUrl(qid)
      const raw = await ctx.fetchJson(url)
      const payload = asRecord(raw)
      const error = asRecord(payload.error)
      if (Object.keys(error).length > 0) {
        throw new Error(
          `Wikidata does not know ${qid}: ${text(error.info) ?? text(error.code) ?? 'no detail given'}`
        )
      }
      const entity = asRecord(asRecord(payload.entities)[qid])
      if (Object.keys(entity).length === 0) {
        throw new Error(
          `Wikidata's answer carried no entity for ${qid}, so no crosswalk is being reported ` +
            '(reading it as "no labels" would turn an unreadable response into a finding).'
        )
      }
      const labels = languageMap(entity.labels)
      const descriptions = languageMap(entity.descriptions)
      const aliases = aliasMap(entity.aliases)
      const missing: string[] = []
      for (const language of LANGUAGES) {
        if (labels[language] === null) missing.push(`${language} label`)
        if (aliases[language]!.length === 0) missing.push(`${language} aliases`)
      }
      const sitelinks = asRecord(entity.sitelinks)
      const site = (key: string): { title: string | null; url: string | null } => {
        const entry = asRecord(sitelinks[key])
        return { title: text(entry.title), url: text(entry.url) }
      }
      const lastRevisionId = Number(entity.lastrevid)
      const notes = [
        'The English label is what the English-language connectors index; the Chinese aliases are ' +
          'listed so a spelling that already resolved is visible.'
      ]
      if (missing.length > 0) {
        notes.push(
          `Not carried for: ${missing.join(', ')}. A missing label/alias set means Wikidata holds none ` +
            'in that language, not that the concept is absent.'
        )
      }
      return {
        qid,
        labels,
        aliases,
        descriptions,
        missing,
        wikipedia: { zhwiki: site('zhwiki'), enwiki: site('enwiki') },
        provenance: {
          entity_url: entityUrl(qid),
          last_revision_id: Number.isFinite(lastRevisionId) ? lastRevisionId : null,
          api: url,
          license: LICENSE
        },
        notes
      }
    }
  }
]
