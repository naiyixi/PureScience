import type { ToolContext, ToolDescriptor } from '../types'

// PDBe (Protein Data Bank in Europe, EMBL-EBI) is a second, independent view of the same archive the RCSB
// tools read, and it answers different questions: which ligands an entry actually contains (with the
// author's own residue numbering), how the secondary structure is assigned per chain, and the entry's
// processing/deposition provenance.
//
// Everything below was confirmed against the live service (2026-10-14, from this machine):
//   • /pdb/entry/summary/<id>            200 — one object with title, methods, dates, entity counts,
//                                        assembly list (1cbs, 4hhb, 6lu7).
//   • /pdb/entry/ligand_monomers/<id>    200 with an array for 1cbs (REA at author residue 200) and 4hhb
//                                        (6 HEM), and 404 for 6lu7, whose service-side entity counts say
//                                        `ligand: 0` — its covalent inhibitor is a second POLYPEPTIDE
//                                        entity. A 404 here therefore means "no ligand-monomer data",
//                                        never "nothing is bound" (see the named state below).
//   • /pdb/entry/secondary_structure/<id> 200 with per-chain helices/strands, and the service OMITS a list
//                                        it would leave empty (4hhb's four chains carry only `helices`;
//                                        6lu7 carries only `strands`). Absent is therefore read as empty,
//                                        which is what the service means by it.
//   • /pdb/entry/ligand_sites/<id>, /binding_sites/<id>, /ligand_interactions/<id> are all 404 (the
//     endpoints do not exist), the per-entry `/services/structure/<entry>` interface answers `[]` for every
//     entry, and the whole-archive `/services/structure/` listing is 442 KB and took 30 s per call here.
//     So this connector deliberately does NOT offer a structure list — a listing that slow is not a tool.
//
// The recurring trap this reader refuses to fall into: an entry has TWO residue numbering schemes. The
// author numbering is what the PDB file writes (and what a paper's "Cys145" means); the label numbering is
// the position in the entity's own sequence, and an insertion code makes 145 and 145B two DIFFERENT
// residues. Both are returned side by side, always labelled, because reporting one of them under an
// unlabelled name is how a caller ends up pointing at the wrong residue.

const PDBE_BASE = 'https://www.ebi.ac.uk/pdbe/api/pdb/entry'

// PDB ids are four characters whose first is a digit (1cbs, 4hhb, 7t9n). Anything else is refused by name
// with no request sent: the service answers 404 for a malformed id exactly as it does for an id it does not
// hold, and a caller must never be handed the same state for "you typo'd" and "the archive has no such entry".
const PDB_ID_RE = /^[0-9][A-Za-z0-9]{3}$/

type EntryFailure = { ok: false; error: string; message: string }
type EntrySuccess = { ok: true; id: string; value: unknown }
type EntryFetch = EntrySuccess | EntryFailure

const strArg = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

const clampInt = (v: unknown, def: number, lo: number, hi: number): number => {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return def
  return Math.min(hi, Math.max(lo, Math.trunc(n)))
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []

const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {}

const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

// Both the malformed-id refusal and the 404 mapping name a state; the message carries what the caller needs
// to decide what to do next. The `notFoundMessage` is supplied per tool because a 404 means something
// different on each endpoint (see the header).
const fetchEntry = async (
  ctx: ToolContext,
  path: string,
  rawId: string,
  notFoundMessage: (id: string) => string
): Promise<EntryFetch> => {
  const id = rawId.toLowerCase()
  if (!PDB_ID_RE.test(id)) {
    return {
      ok: false,
      error: 'invalid-id',
      message: `"${rawId}" is not a PDB id (four characters, the first a digit — e.g. 1cbs, 4hhb, 7t9n). No request was sent.`
    }
  }
  try {
    const payload = await ctx.fetchJson(`${PDBE_BASE}/${path}/${id}`)
    // The service keys its answer by the lower-cased id, and answers one entry per request. A payload that
    // is not that single-key object is a shape this reader does not know, and saying so is better than
    // reaching into it and returning nulls that read as real data.
    const keys = Object.keys(record(payload))
    if (keys.length !== 1 || Array.isArray(payload)) {
      return {
        ok: false,
        error: 'unexpected-shape',
        message: `PDBe /${path}/${id} answered a shape this reader does not know (expected one key holding the entry).`
      }
    }
    return { ok: true, id, value: record(payload)[keys[0]] }
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error)
    // The shared fetch layer reports the status in its own message; that string is the only status signal a
    // descriptor gets, so it is what is matched here.
    if (/\bHTTP 404\b/.test(text))
      return { ok: false, error: 'not-found', message: notFoundMessage(id) }
    return {
      ok: false,
      error: 'source-unreadable',
      message: `PDBe /${path}/${id}: ${text.slice(0, 300)}`
    }
  }
}

// One residue identity, in BOTH schemes, with the insertion code spelled out: `145` and `145B` are two
// different residues and the author numbering is the one a paper writes.
const residueIdentity = (v: unknown): Record<string, unknown> => {
  const r = record(v)
  return {
    author_residue_number: r.author_residue_number ?? null,
    author_insertion_code: r.author_insertion_code ?? null,
    label_residue_number: r.residue_number ?? null
  }
}

export const STRUCTURES_PDBE_TOOLS: ToolDescriptor[] = [
  {
    id: 'pdbe_entry_summary',
    connector: 'structures-pdbe',
    description:
      "The entry-level record for one PDB entry, as EMBL-EBI's PDBe holds it: title, experimental method and its class, deposition/release/revision dates, the processing and deposition sites, the authors, the entity counts, and the assemblies. Use it to state what an entry is and where its coordinates came from. Args: pdb_id (four characters, first a digit, e.g. 1cbs). Returns {source, pdb_id, title, experimental_method[], experimental_method_class[], processing_site, deposition_site, deposition_date, release_date, revision_date, entry_authors[], number_of_entities, assemblies[{assembly_id, name, form, preferred}]} or a named error (invalid-id / not-found / unexpected-shape / source-unreadable). Dates are the service's own YYYYMMDD strings, not reformatted here; number_of_entities is passed through as the service writes it (water / polypeptide / ligand / ...), and processing_site and deposition_site are returned as the service holds them and do differ - they are not one field under two names. Requires network access to www.ebi.ac.uk.",
    input: {
      type: 'object',
      properties: { pdb_id: { type: 'string', description: 'PDB id, e.g. 1cbs' } },
      required: ['pdb_id']
    },
    required: ['pdb_id'],
    returns:
      '{source, pdb_id, title, experimental_method[], experimental_method_class[], processing_site, deposition_site, deposition_date, release_date, revision_date, entry_authors[], number_of_entities, assemblies[]} or {error: invalid-id|not-found|unexpected-shape|source-unreadable, message}.',
    example:
      'const result = await host.mcp("structures-pdbe", "pdbe_entry_summary", {"pdb_id": "1cbs"})',
    run: async (ctx: ToolContext, a: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const fetched = await fetchEntry(ctx, 'summary', strArg(a.pdb_id), (id) => {
        return `${id}: PDBe holds no summary for this entry (its own answer is 404 "Requested endpoint does not contain any data") — either no such entry exists or it is not served here. No other endpoint was tried.`
      })
      if (!fetched.ok) return { error: fetched.error, message: fetched.message }

      const entries = list(fetched.value)
      const entry = record(entries[0])
      if (entries.length === 0) {
        return {
          error: 'unexpected-shape',
          message: `PDBe /summary/${fetched.id} answered an empty entry list, which no entry has done in testing.`
        }
      }

      return {
        source: 'PDBe (Protein Data Bank in Europe, EMBL-EBI) - /pdb/entry/summary',
        // The id the service answered under (it lower-cases), so the caller sees what actually resolved.
        pdb_id: fetched.id,
        title: entry.title ?? null,
        experimental_method: strings(entry.experimental_method),
        experimental_method_class: strings(entry.experimental_method_class),
        processing_site: entry.processing_site ?? null,
        deposition_site: entry.deposition_site ?? null,
        deposition_date: entry.deposition_date ?? null,
        release_date: entry.release_date ?? null,
        revision_date: entry.revision_date ?? null,
        entry_authors: strings(entry.entry_authors),
        number_of_entities: entry.number_of_entities ?? null,
        assemblies: list(entry.assemblies).map((raw) => {
          const assembly = record(raw)
          return {
            assembly_id: assembly.assembly_id ?? null,
            name: assembly.name ?? null,
            form: assembly.form ?? null,
            preferred: typeof assembly.preferred === 'boolean' ? assembly.preferred : null
          }
        })
      }
    }
  },
  {
    id: 'pdbe_ligands',
    connector: 'structures-pdbe',
    description:
      "The ligand (non-polymer) instances PDBe records for one entry — each with the chemical component id and name, its weight, the entity and chain it sits in, and its residue identity in BOTH numbering schemes. Use it to find what is bound and where, before extracting a pose or defining a pocket. Args: pdb_id; max_ligands (1-500, default 50). Returns {source, pdb_id, n_ligands_total, truncated, ligands: [{chem_comp_id, chem_comp_name, weight, entity_id, chain_id, struct_asym_id, author_residue_number, author_insertion_code, label_residue_number, alternate_conformers, bm_id}]} or a named error. author_residue_number + author_insertion_code are what the PDB file writes and what a paper cites (145 and 145B are different residues); label_residue_number is the service's sequential position in the entity, and the two differ for entries whose author numbering is not sequential. bm_id is the binding-monomer id the service assigns. A 404 answers as error `not-found`, which is NOT 'nothing is bound': an entry whose inhibitor is modelled as a peptide entity (or bound covalently) has no ligand monomer here — read pdbe_entry_summary's number_of_entities (ligand vs polypeptide) before calling a site empty. Requires network access to www.ebi.ac.uk.",
    input: {
      type: 'object',
      properties: {
        pdb_id: { type: 'string', description: 'PDB id, e.g. 4hhb' },
        max_ligands: { type: 'integer', minimum: 1, maximum: 500, default: 50 }
      },
      required: ['pdb_id']
    },
    required: ['pdb_id'],
    returns:
      '{source, pdb_id, n_ligands_total, truncated, ligands: [{chem_comp_id, chem_comp_name, weight, entity_id, chain_id, struct_asym_id, author_residue_number, author_insertion_code, label_residue_number, alternate_conformers, bm_id}]} or {error: invalid-id|not-found|unexpected-shape|source-unreadable, message}.',
    example: 'const result = await host.mcp("structures-pdbe", "pdbe_ligands", {"pdb_id": "4hhb"})',
    run: async (ctx: ToolContext, a: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const fetched = await fetchEntry(ctx, 'ligand_monomers', strArg(a.pdb_id), (id) => {
        return `${id}: PDBe holds no ligand-monomer data for this entry. That is not the same as "nothing is bound" — an entry whose inhibitor is modelled as a peptide entity or bound covalently has none here (6lu7's counts read ligand: 0 and polypeptide: 2 for exactly that reason). Check number_of_entities from pdbe_entry_summary before reading this as an empty binding site.`
      })
      if (!fetched.ok) return { error: fetched.error, message: fetched.message }

      const all = list(fetched.value)
      const maxLigands = clampInt(a.max_ligands, 50, 1, 500)
      const ligands = all.slice(0, maxLigands).map((raw) => {
        const ligand = record(raw)
        return {
          chem_comp_id: ligand.chem_comp_id ?? null,
          chem_comp_name: ligand.chem_comp_name ?? null,
          weight: ligand.weight ?? null,
          entity_id: ligand.entity_id ?? null,
          chain_id: ligand.chain_id ?? null,
          struct_asym_id: ligand.struct_asym_id ?? null,
          author_residue_number: ligand.author_residue_number ?? null,
          author_insertion_code: ligand.author_insertion_code ?? null,
          label_residue_number: ligand.residue_number ?? null,
          alternate_conformers: ligand.alternate_conformers ?? null,
          bm_id: ligand.bm_id ?? null
        }
      })

      return {
        source: 'PDBe (Protein Data Bank in Europe, EMBL-EBI) - /pdb/entry/ligand_monomers',
        pdb_id: fetched.id,
        n_ligands_total: all.length,
        truncated: all.length > ligands.length,
        ligands
      }
    }
  },
  {
    id: 'pdbe_secondary_structure',
    connector: 'structures-pdbe',
    description:
      'The secondary-structure assignment PDBe holds for one entry: helices and strands per chain, each with its start/end residue in both numbering schemes, and the sheet id for strands (the service omits a list it would leave empty, so an absent helices/strands key means none were assigned to that chain, not that the answer is missing). Args: pdb_id; max_segments (1-2000, default 400, counted across all chains). Returns {source, pdb_id, n_segments_total, truncated, molecules: [{entity_id, chains: [{chain_id, helices: [{start, end}], strands: [{sheet_id, start, end}]}]}]} where start/end are {author_residue_number, author_insertion_code, label_residue_number}, or a named error. Use it to map a region of interest onto structural elements — or, together with the entity list, to see which parts of a chain carry an assignment at all. Requires network access to www.ebi.ac.uk.',
    input: {
      type: 'object',
      properties: {
        pdb_id: { type: 'string', description: 'PDB id, e.g. 4hhb' },
        max_segments: { type: 'integer', minimum: 1, maximum: 2000, default: 400 }
      },
      required: ['pdb_id']
    },
    required: ['pdb_id'],
    returns:
      '{source, pdb_id, n_segments_total, truncated, molecules: [{entity_id, chains: [{chain_id, helices: [{start, end}], strands: [{sheet_id, start, end}]}]}]} or {error: invalid-id|not-found|unexpected-shape|source-unreadable, message}.',
    example:
      'const result = await host.mcp("structures-pdbe", "pdbe_secondary_structure", {"pdb_id": "4hhb"})',
    run: async (ctx: ToolContext, a: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const fetched = await fetchEntry(ctx, 'secondary_structure', strArg(a.pdb_id), (id) => {
        return `${id}: PDBe holds no secondary-structure answer for this entry (404). Either no such entry exists or it carries no assignment — this reader cannot tell those apart from the status alone.`
      })
      if (!fetched.ok) return { error: fetched.error, message: fetched.message }

      const molecules = list(record(fetched.value).molecules)
      if (molecules.length === 0) {
        return {
          error: 'unexpected-shape',
          message: `PDBe /secondary_structure/${fetched.id} answered with no molecules block, which no entry has done in testing.`
        }
      }

      const maxSegments = clampInt(a.max_segments, 400, 1, 2000)
      let total = 0
      const capped: Array<Record<string, unknown>> = []

      // Count every segment first (the service's own total), then hand back the first `max_segments` in the
      // order the service wrote them — so `truncated` is a comparison against a real total, not a guess.
      for (const rawMolecule of molecules) {
        const molecule = record(rawMolecule)
        const chains: Array<Record<string, unknown>> = []
        for (const rawChain of list(molecule.chains)) {
          const chain = record(rawChain)
          const ss = record(chain.secondary_structure)
          const helices = list(ss.helices)
          const strands = list(ss.strands)
          total += helices.length + strands.length
          chains.push({
            chain_id: chain.chain_id ?? null,
            helices: helices.map((h) => {
              const helix = record(h)
              return { start: residueIdentity(helix.start), end: residueIdentity(helix.end) }
            }),
            strands: strands.map((s) => {
              const strand = record(s)
              return {
                sheet_id: strand.sheet_id ?? null,
                start: residueIdentity(strand.start),
                end: residueIdentity(strand.end)
              }
            })
          })
        }
        capped.push({ entity_id: molecule.entity_id ?? null, chains })
      }

      // Trim the collected chains down to the cap, dropping whole segments (never splitting one).
      let remaining = maxSegments
      const moleculesOut = capped.map((molecule) => {
        const chains = (molecule.chains as Array<Record<string, unknown>>).map((chain) => {
          const helices = (chain.helices as unknown[]).slice(0, Math.max(0, remaining))
          remaining -= helices.length
          const strands = (chain.strands as unknown[]).slice(0, Math.max(0, remaining))
          remaining -= strands.length
          return { chain_id: chain.chain_id, helices, strands }
        })
        return { entity_id: molecule.entity_id, chains }
      })
      const returned = moleculesOut.reduce(
        (sum, molecule) =>
          sum +
          molecule.chains.reduce(
            (chainSum, chain) => chainSum + chain.helices.length + chain.strands.length,
            0
          ),
        0
      )

      return {
        source: 'PDBe (Protein Data Bank in Europe, EMBL-EBI) - /pdb/entry/secondary_structure',
        pdb_id: fetched.id,
        n_segments_total: total,
        truncated: total > returned,
        molecules: moleculesOut
      }
    }
  }
]
