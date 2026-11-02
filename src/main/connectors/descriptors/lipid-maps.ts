import type { ToolContext, ToolDescriptor } from '../types'

// LIPID MAPS Structure Database (LMSD) REST API. Read-only, exact-match lookup by an identifier the
// database itself indexes — this endpoint has NO name search: `compound/name/...` answers
// "This input item does not exist; choose from: formula, regno, inchi_key, lm_id, pubchem_cid, hmdb_id,
// kegg_id, chebi_id, smiles, abbrev, abbrev_chains" (measured 2026-11-02). A caller who has only a common
// name must resolve it to one of those first (e.g. through the chemistry connector's PubChem tool).
const BASE = 'https://www.lipidmaps.org/rest/compound'

/** The identifier kinds the API actually accepts, in its own spelling. */
const INPUT_TYPES = [
  'lm_id',
  'regno',
  'pubchem_cid',
  'hmdb_id',
  'kegg_id',
  'chebi_id',
  'inchi_key',
  'formula',
  'smiles',
  'abbrev',
  'abbrev_chains'
] as const

type LmsdRecord = {
  input?: string
  regno?: string
  lm_id?: string
  name?: string
  sys_name?: string
  synonyms?: string
  abbrev?: string
  core?: string
  main_class?: string
  sub_class?: string
  exactmass?: string
  formula?: string
  inchi?: string
  inchi_key?: string
  kegg_id?: string
  hmdb_id?: string
  chebi_id?: string
  lipidbank_id?: string
  pubchem_cid?: string
  smiles?: string
}

const asRecords = (payload: unknown): LmsdRecord[] => {
  if (Array.isArray(payload)) return payload as LmsdRecord[]
  if (payload && typeof payload === 'object') return [payload as LmsdRecord]
  return []
}

// The service answers a lookup that matched nothing with an empty array, and answers an unsupported
// identifier kind with an HTML sentence — both are 200s, so the shape is what decides, not the status.
const isUnsupportedKindText = (payload: unknown): boolean =>
  typeof payload === 'string' && payload.includes('This input item does not exist')

const describe = (record: LmsdRecord): Record<string, unknown> => ({
  lm_id: record.lm_id ?? null,
  name: record.name ?? null,
  systematic_name: record.sys_name ?? null,
  formula: record.formula ?? null,
  // Kept as the service writes it: the exact mass is a decimal string, and turning it into a float would
  // silently drop digits on large lipids.
  exact_mass: record.exactmass ?? null,
  smiles: record.smiles ?? null,
  inchi_key: record.inchi_key ?? null,
  abbrev: record.abbrev ?? null,
  core: record.core ?? null,
  main_class: record.main_class ?? null,
  sub_class: record.sub_class ?? null,
  synonyms: record.synonyms ? record.synonyms.split(';').map((entry) => entry.trim()) : [],
  regno: record.regno ?? null,
  pubchem_cid: record.pubchem_cid ?? null,
  hmdb_id: record.hmdb_id ?? null,
  kegg_id: record.kegg_id ?? null,
  chebi_id: record.chebi_id ?? null,
  lipidbank_id: record.lipidbank_id ?? null
})

export const LIPID_MAPS_TOOLS: ToolDescriptor[] = [
  {
    id: 'lipidmaps_compound_lookup',
    connector: 'lipid-maps',
    description:
      'Exact lookup of one lipid in the LIPID MAPS Structure Database (LMSD) by an identifier LMSD itself indexes. Args: input_type (one of lm_id, regno, pubchem_cid, hmdb_id, kegg_id, chebi_id, inchi_key, formula, smiles, abbrev, abbrev_chains) and input (the identifier value, e.g. "LMST01010001" or "5997"). Returns {source, input_type, input, n_results, compounds: [{lm_id, name, systematic_name, formula, exact_mass, smiles, inchi_key, abbrev, core, main_class, sub_class, synonyms[], regno, pubchem_cid, hmdb_id, kegg_id, chebi_id, lipidbank_id}]} or a named error. There is NO name search — a common name must first be resolved to one of these identifier kinds. formula and smiles legitimately return several compounds (a formula does not name one lipid), which is why the result is a list with a count rather than a single record. exact_mass is the service decimal string, never re-rounded. Requires network access to www.lipidmaps.org.',
    input: {
      type: 'object',
      properties: {
        input_type: { type: 'string', enum: [...INPUT_TYPES], description: 'Identifier kind' },
        input: {
          type: 'string',
          description: 'Identifier value, e.g. LMST01010001, 5997, C00187, C27H46O'
        }
      },
      required: ['input_type', 'input']
    },
    required: ['input_type', 'input'],
    returns:
      '{source, input_type, input, n_results, compounds[]} or {error: unsupported-input-type|unexpected-shape|source-unreadable, message}',
    example:
      'const result = await host.mcp("lipid-maps", "lipidmaps_compound_lookup", {"input_type": "lm_id", "input": "LMST01010001"})',
    format: 'json',
    run: async (ctx: ToolContext, a: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const inputType = String(a.input_type ?? '').trim()
      const input = String(a.input ?? '').trim()
      if (!(INPUT_TYPES as readonly string[]).includes(inputType)) {
        return {
          error: 'unsupported-input-type',
          message: `LIPID MAPS accepts ${INPUT_TYPES.join(', ')} — not "${inputType}". There is no name search; resolve a name to one of these first.`
        }
      }
      if (!input) {
        return { error: 'unsupported-input-type', message: 'input is empty.' }
      }

      const url = `${BASE}/${inputType}/${encodeURIComponent(input)}/all`
      const text = await ctx.fetchText(url)
      if (isUnsupportedKindText(text)) {
        return { error: 'unsupported-input-type', message: text.replace(/<[^>]*>/g, ' ').trim() }
      }

      let payload: unknown
      try {
        payload = JSON.parse(text)
      } catch {
        return {
          error: 'unexpected-shape',
          message: `LIPID MAPS answered something that is not JSON (${text.slice(0, 120)}).`
        }
      }

      const compounds = asRecords(payload).map(describe)
      return {
        source: 'LIPID MAPS (LMSD)',
        input_type: inputType,
        input,
        n_results: compounds.length,
        compounds,
        // An empty answer is a measurement, not a failure: the identifier is valid but LMSD holds no
        // compound for it, and saying so is different from saying the service could not be read.
        note: compounds.length === 0 ? 'LMSD holds no compound for this identifier.' : undefined
      }
    }
  }
]
