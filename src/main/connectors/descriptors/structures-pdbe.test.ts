import { describe, expect, it, vi } from 'vitest'

import { ParserEngine } from '../engine'
import type { ToolDescriptor } from '../types'
import { STRUCTURES_PDBE_TOOLS } from './structures-pdbe'

const tool = (id: string): ToolDescriptor => STRUCTURES_PDBE_TOOLS.find((t) => t.id === id)!

const jsonRes = (body: unknown): Response =>
  ({
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body)
  }) as unknown as Response

const notFoundRes = (): Response =>
  ({
    ok: false,
    status: 404,
    json: async () => ({ message: 'Requested endpoint does not contain any data' }),
    text: async () => '{"message":"Requested endpoint does not contain any data"}'
  }) as unknown as Response

describe('structures-pdbe / pdbe_entry_summary', () => {
  it('refuses an id that is not a PDB id without sending a request', async () => {
    const fetchImpl = vi.fn()
    const out = (await new ParserEngine({ fetchImpl }).call(
      tool('pdbe_entry_summary'),
      { pdb_id: '1cbsx' },
      {}
    )) as { error: string; message: string }

    expect(out.error).toBe('invalid-id')
    expect(out.message).toContain('No request was sent')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('answers under the lower-cased id the service uses and keeps its dates and entity counts as written', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonRes({
        '1cbs': [
          {
            title: 'CRYSTAL STRUCTURE OF CELLULAR RETINOIC-ACID-BINDING PROTEINS I AND II',
            processing_site: 'BNL',
            deposition_site: null,
            deposition_date: '19940928',
            release_date: '19950126',
            revision_date: '20240207',
            experimental_method_class: ['x-ray'],
            experimental_method: ['X-ray diffraction'],
            entry_authors: ['Kleywegt, G.J.', 'Bergfors, T.', 'Jones, T.A.'],
            number_of_entities: { water: 1, polypeptide: 1, ligand: 1 },
            assemblies: [{ assembly_id: '1', name: 'monomer', form: 'homo', preferred: true }]
          }
        ]
      })
    )
    const out = (await new ParserEngine({ fetchImpl }).call(
      tool('pdbe_entry_summary'),
      { pdb_id: '1CBS' },
      {}
    )) as Record<string, unknown>

    expect(String(fetchImpl.mock.calls[0][0])).toBe(
      'https://www.ebi.ac.uk/pdbe/api/pdb/entry/summary/1cbs'
    )
    expect(out.pdb_id).toBe('1cbs')
    expect(out.deposition_date).toBe('19940928')
    expect(out.processing_site).toBe('BNL')
    expect(out.deposition_site).toBeNull()
    expect(out.number_of_entities).toEqual({ water: 1, polypeptide: 1, ligand: 1 })
    expect(out.assemblies).toEqual([
      { assembly_id: '1', name: 'monomer', form: 'homo', preferred: true }
    ])
  })

  it('names a 404 as not-found instead of returning an empty record', async () => {
    // Measured 2026-10-14: PDBe answers 404 for `0aaa` — and for both "no such entry" and "no data for this
    // endpoint", which is why the state says both. (Two ids that look invented, 9zzz and 5xyz, turned out to
    // be real entries with a 200, so absence is never inferred from the shape of an id.)
    const fetchImpl = vi.fn().mockResolvedValueOnce(notFoundRes())
    const out = (await new ParserEngine({ fetchImpl }).call(
      tool('pdbe_entry_summary'),
      { pdb_id: '0aaa' },
      {}
    )) as { error: string; message: string }

    expect(out.error).toBe('not-found')
    expect(out.message).toContain('0aaa')
    expect(out.message).toContain('No other endpoint was tried')
  })

  it('names a payload that is not the single-key answer as an unknown shape', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonRes({ a: [], b: [] }))
    const out = (await new ParserEngine({ fetchImpl }).call(
      tool('pdbe_entry_summary'),
      { pdb_id: '1cbs' },
      {}
    )) as { error: string }

    expect(out.error).toBe('unexpected-shape')
  })
})

describe('structures-pdbe / pdbe_ligands', () => {
  it('reports both numbering schemes and the insertion code, and truncates against the service total', async () => {
    const ligand = (id: string, author: number, insertion: string): Record<string, unknown> => ({
      chain_id: 'A',
      author_residue_number: author,
      author_insertion_code: insertion,
      chem_comp_id: id,
      alternate_conformers: 0,
      entity_id: 2,
      struct_asym_id: 'B',
      residue_number: 1,
      chem_comp_name: 'RETINOIC ACID',
      weight: 300.435,
      bm_id: 'bm1'
    })
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonRes({
        '1cbs': [ligand('REA', 200, ''), ligand('REB', 145, 'B'), ligand('REC', 145, '')]
      })
    )
    const out = (await new ParserEngine({ fetchImpl }).call(
      tool('pdbe_ligands'),
      { pdb_id: '1cbs', max_ligands: 2 },
      {}
    )) as {
      n_ligands_total: number
      truncated: boolean
      ligands: Array<Record<string, unknown>>
    }

    expect(out.n_ligands_total).toBe(3)
    expect(out.truncated).toBe(true)
    expect(out.ligands).toHaveLength(2)
    expect(out.ligands[0]).toMatchObject({
      chem_comp_id: 'REA',
      author_residue_number: 200,
      label_residue_number: 1,
      bm_id: 'bm1'
    })
    // 145 and 145B are two different residues: the insertion code must survive, not be folded away.
    expect(out.ligands[1]).toMatchObject({ author_residue_number: 145, author_insertion_code: 'B' })
  })

  it('does not let a 404 read as an empty binding site', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(notFoundRes())
    const out = (await new ParserEngine({ fetchImpl }).call(
      tool('pdbe_ligands'),
      { pdb_id: '6lu7' },
      {}
    )) as { error: string; message: string }

    expect(out.error).toBe('not-found')
    expect(out.message).toContain('no ligand-monomer data')
    expect(out.message).toContain('number_of_entities')
  })
})

describe('structures-pdbe / pdbe_secondary_structure', () => {
  it('reads an omitted list as none assigned, and reports a truncation against the full total', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonRes({
        '4hhb': {
          molecules: [
            {
              entity_id: 1,
              chains: [
                {
                  chain_id: 'A',
                  // 4hhb's real shape: strands is absent, which the service omits when it would be empty.
                  secondary_structure: {
                    helices: [
                      {
                        start: {
                          residue_number: 15,
                          author_residue_number: 15,
                          author_insertion_code: null
                        },
                        end: {
                          residue_number: 21,
                          author_residue_number: 21,
                          author_insertion_code: null
                        }
                      },
                      {
                        start: {
                          residue_number: 30,
                          author_residue_number: 30,
                          author_insertion_code: null
                        },
                        end: {
                          residue_number: 40,
                          author_residue_number: 40,
                          author_insertion_code: null
                        }
                      }
                    ]
                  }
                },
                {
                  chain_id: 'B',
                  // 6lu7's real shape: only strands present.
                  secondary_structure: {
                    strands: [
                      {
                        sheet_id: 1,
                        start: {
                          residue_number: 5,
                          author_residue_number: 5,
                          author_insertion_code: null
                        },
                        end: {
                          residue_number: 13,
                          author_residue_number: 13,
                          author_insertion_code: null
                        }
                      }
                    ]
                  }
                }
              ]
            }
          ]
        }
      })
    )
    const out = (await new ParserEngine({ fetchImpl }).call(
      tool('pdbe_secondary_structure'),
      { pdb_id: '4hhb', max_segments: 2 },
      {}
    )) as {
      n_segments_total: number
      truncated: boolean
      molecules: Array<{ entity_id: number; chains: Array<Record<string, unknown>> }>
    }

    expect(out.n_segments_total).toBe(3)
    expect(out.truncated).toBe(true)
    const chains = out.molecules[0].chains
    expect(chains[0].helices).toHaveLength(2)
    expect(chains[0].strands).toEqual([])
    expect(chains[1].helices).toEqual([])
    // The cap lands on whole segments: the third segment (chain B's strand) is dropped, not split.
    expect(chains[1].strands).toEqual([])
    expect((chains[0].helices as Array<Record<string, unknown>>)[0]).toEqual({
      start: { author_residue_number: 15, author_insertion_code: null, label_residue_number: 15 },
      end: { author_residue_number: 21, author_insertion_code: null, label_residue_number: 21 }
    })
  })

  it('names an answer with no molecules block rather than returning an empty structure', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonRes({ '4hhb': { molecules: [] } }))
    const out = (await new ParserEngine({ fetchImpl }).call(
      tool('pdbe_secondary_structure'),
      { pdb_id: '4hhb' },
      {}
    )) as { error: string }

    expect(out.error).toBe('unexpected-shape')
  })
})
