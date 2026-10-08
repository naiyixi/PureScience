import { describe, expect, it, vi } from 'vitest'

import { IMMUNE_EPITOPES_TOOLS } from './immune-epitopes'

const tool = (id: string): (typeof IMMUNE_EPITOPES_TOOLS)[number] => {
  const found = IMMUNE_EPITOPES_TOOLS.find((candidate) => candidate.id === id)
  if (!found || !found.run) throw new Error(`descriptor ${id} is missing or has no run()`)
  return found
}

// A context whose fetchJson records every URL and answers from a scripted list of bodies.
const ctxWith = (bodies: unknown[]): { ctx: unknown; urls: string[] } => {
  const urls: string[] = []
  const fetchJson = vi.fn(async (url: string) => {
    urls.push(url)
    const next = bodies.shift()
    if (next instanceof Error) throw next
    return next
  })
  return { ctx: { fetchJson, fetchText: vi.fn(), credentials: {} }, urls }
}

const epitopeRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  structure_id: 31803,
  structure_iri: 'IEDB_EPITOPE:31803',
  structure_descriptions: ['KLEDLERDL'],
  structure_type: 'Linear peptide',
  linear_sequence: 'KLEDLERDL',
  linear_sequence_length: 9,
  e_modification: null,
  curated_source_antigens: [
    { accession: 'P12345', name: 'Example antigen', iri: 'UNIPROT:P12345' }
  ],
  host_organism_names: ['Homo sapiens (human)'],
  source_organism_names: ['Homo sapiens (human)'],
  mhc_allele_names: ['HLA-A*02:01'],
  disease_names: null,
  iedb_assay_ids: [2474740],
  iedb_assay_iris: ['IEDB_ASSAY:2474740'],
  assay_names: ['multimer/tetramer'],
  qualitative_measures: ['Positive'],
  reference_ids: [1029216],
  reference_iris: ['IEDB_REFERENCE:1029216'],
  ...overrides
})

const assayRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  tcell_id: 99,
  tcell_iri: 'IEDB_TCELL:99',
  bcell_id: null,
  bcell_iri: null,
  structure_id: 31803,
  structure_iri: 'IEDB_EPITOPE:31803',
  linear_sequence: 'KLEDLERDL',
  structure_type: 'Linear peptide',
  curated_source_antigen: 'Example antigen (UniProt:P12345)',
  reference_id: 1029216,
  reference_iri: 'IEDB_REFERENCE:1029216',
  reference_type: 'Journal article',
  pubmed_id: 15448372,
  reference_authors: 'A Author',
  reference_titles: 'A title',
  journal_name: 'J Immunol',
  reference_dates: '2004-09-01',
  // Deliberately carries markup, as the live service does.
  assay_description: 'multimer/tetramer<br/>qualitative binding<br/><strong>Positive</strong>',
  immunization_description: null,
  antigen_description: null,
  mhc_restriction: 'HLA-A*02:01',
  mhc_class: 'I',
  mhc_allele_resolution: 'Four-digit',
  mhc_allele_evidence: 'Single allele present',
  qualitative_measure: '<strong>Positive</strong>',
  antibody_isotype: null,
  direct_ex_vivo_bool: 1,
  ...overrides
})

describe('iedb_search_epitopes', () => {
  it('sends a verified filter, always sends an order, and asks for one row more than requested', async () => {
    const { ctx, urls } = ctxWith([[epitopeRow()]])
    const out = (await tool('iedb_search_epitopes').run!(ctx as never, {
      sequence: 'KLEDLERDL',
      max_rows: 5
    })) as Record<string, unknown>

    const url = urls[0]!
    expect(url.startsWith('https://query-api.iedb.org/epitope_search?')).toBe(true)
    expect(url).toContain('linear_sequence=eq.KLEDLERDL')
    expect(url).toContain('limit=6') // max_rows + 1 — that extra row is what makes `truncated` a reading
    expect(url).toContain('order=structure_id.asc') // the service refuses offset-paging without it
    expect(url).toContain('select=')
    expect(out.n_retrieved).toBe(1)
    expect(out.truncated).toBe(false)
    expect(out.search_mode).toBe('exact peptide sequence')
  })

  it('normalises FASTA headers, line breaks and case, and says it did', async () => {
    const { ctx, urls } = ctxWith([[]])
    const out = (await tool('iedb_search_epitopes').run!(ctx as never, {
      sequence: '>sp|P12345|EX_HUMAN\nkledler\ndl\n'
    })) as Record<string, unknown>

    expect(urls[0]).toContain('linear_sequence=eq.KLEDLERDL')
    expect((out.filtered_by as string[]).includes('sequence=KLEDLERDL')).toBe(true)
    expect(
      (out.notes as string[]).some((note) => note.includes('stripped 1 FASTA header line'))
    ).toBe(true)
  })

  it('reports truncation from the extra row instead of guessing a total', async () => {
    const { ctx } = ctxWith([
      [epitopeRow(), epitopeRow({ structure_id: 2, structure_iri: 'IEDB_EPITOPE:2' })]
    ])
    const out = (await tool('iedb_search_epitopes').run!(ctx as never, {
      sequence: 'KLEDLERDL',
      max_rows: 1
    })) as Record<string, unknown>

    expect(out.n_retrieved).toBe(1)
    expect(out.truncated).toBe(true) // the service reports no total, so this is the only honest reading
  })

  it('says "no curated evidence" on an empty result rather than anything that reads as a negative', async () => {
    const { ctx } = ctxWith([[]])
    const out = (await tool('iedb_search_epitopes').run!(ctx as never, {
      structure_iri: 'IEDB_EPITOPE:31803'
    })) as Record<string, unknown>

    expect(out.rows).toEqual([])
    const notes = (out.notes as string[]).join(' ')
    expect(notes).toContain('No curated epitope evidence matched this exact query')
    expect(notes).toContain('NOT evidence of absence')
  })

  it('refuses a sequence that is not one-letter amino-acid code, naming the character and position', async () => {
    const { ctx, urls } = ctxWith([[epitopeRow()]])
    await expect(
      tool('iedb_search_epitopes').run!(ctx as never, { sequence: 'MQIFV!KLTG' })
    ).rejects.toThrow(/position 6 is "!", which is not a one-letter amino-acid code/)
    expect(urls).toEqual([]) // nothing was sent: a bad input must not come back as "not in the database"
  })

  it('refuses an over-long input and an empty one by name', async () => {
    const { ctx } = ctxWith([[epitopeRow()]])
    await expect(
      tool('iedb_search_epitopes').run!(ctx as never, { sequence: 'A'.repeat(201) })
    ).rejects.toThrow(/201 residues long/)
    await expect(
      tool('iedb_search_epitopes').run!(ctx as never, { sequence: '  \n>only a header\n' })
    ).rejects.toThrow(/sequence is empty after removing whitespace and FASTA header lines/)
  })

  it('refuses both-name and no-name argument shapes, and an out-of-range max_rows', async () => {
    const { ctx } = ctxWith([[epitopeRow()]])
    const run = tool('iedb_search_epitopes').run!
    await expect(
      run(ctx as never, { sequence: 'KLEDLERDL', structure_iri: 'IEDB_EPITOPE:31803' })
    ).rejects.toThrow(/either sequence or structure_iri, not both/)
    await expect(run(ctx as never, {})).rejects.toThrow(
      /Pass a peptide sequence or an IEDB epitope IRI/
    )
    await expect(run(ctx as never, { sequence: 'KLEDLERDL', max_rows: 501 })).rejects.toThrow(
      /max_rows must be an integer between 1 and 100/
    )
  })

  it('lets a service-side rejection fail the call instead of returning an empty page', async () => {
    const { ctx } = ctxWith([
      new Error('column epitope_search.nonexistent_col does not exist (42703)')
    ])
    await expect(
      tool('iedb_search_epitopes').run!(ctx as never, { sequence: 'KLEDLERDL' })
    ).rejects.toThrow(/42703/)
  })

  it('maps the row and strips the service markup out of its prose', async () => {
    const { ctx } = ctxWith([[epitopeRow()]])
    const out = (await tool('iedb_search_epitopes').run!(ctx as never, {
      sequence: 'KLEDLERDL'
    })) as {
      rows: Array<Record<string, unknown>>
    }
    const row = out.rows[0]!
    expect(row).toMatchObject({
      epitope_iri: 'IEDB_EPITOPE:31803',
      sequence: 'KLEDLERDL',
      sequence_length: 9,
      host_organisms: ['Homo sapiens (human)'],
      mhc_alleles: ['HLA-A*02:01'],
      assay_iris: ['IEDB_ASSAY:2474740'],
      reference_iris: ['IEDB_REFERENCE:1029216']
    })
    expect(row.source_antigens).toEqual([
      { accession: 'P12345', name: 'Example antigen', iri: 'UNIPROT:P12345' }
    ])
    expect(row.diseases).toEqual([]) // absent in the payload, reported as an empty list
  })
})

describe('iedb_search_assays', () => {
  it('reads both receptor families, counts them separately and keeps each citation', async () => {
    const { ctx, urls } = ctxWith([[assayRow()], []])
    const out = (await tool('iedb_search_assays').run!(ctx as never, {
      structure_iri: 'IEDB_EPITOPE:31803',
      kind: 'both',
      max_rows: 3
    })) as Record<string, unknown>

    expect(urls).toHaveLength(2)
    expect(urls[0]).toContain('/tcell_search?')
    expect(urls[1]).toContain('/bcell_search?')
    expect(urls[0]).toContain('structure_iri=eq.IEDB_EPITOPE%3A31803')
    expect(urls[0]).toContain('order=tcell_id.asc')
    expect(urls[1]).toContain('order=bcell_id.asc')
    expect(out.n_retrieved).toEqual({ tcell: 1, bcell: 0 })
    expect(out.truncated).toEqual({ tcell: false, bcell: false })

    const row = (out.rows as Array<Record<string, unknown>>)[0]!
    // Markup is gone — the method reads as prose, and the citation carries a resolvable PubMed link.
    expect(row.method).toBe('multimer/tetramer · qualitative binding · Positive')
    expect(row.qualitative_measure).toBe('Positive')
    expect(row.citation).toMatchObject({
      pubmed_id: 15448372,
      pubmed_url: 'https://pubmed.ncbi.nlm.nih.gov/15448372/',
      journal: 'J Immunol'
    })
    expect(row.mhc).toMatchObject({ class: 'I', restriction: 'HLA-A*02:01' })
    expect(row.direct_ex_vivo).toBe(true)
  })

  it('names the receptor family that returned nothing, so it cannot be read as "no response"', async () => {
    const { ctx } = ctxWith([[assayRow()], []])
    const out = (await tool('iedb_search_assays').run!(ctx as never, {
      structure_iri: 'IEDB_EPITOPE:31803'
    })) as Record<string, unknown>
    const notes = (out.notes as string[]).join(' ')
    expect(notes).toContain('No curated b-cell assay evidence matched this exact query')
    expect(notes).toContain('NOT evidence of absence')
    expect(notes).not.toContain('t-cell assay evidence matched this exact query')
  })

  it('says both families are empty when both are, and asks only for the one that was requested', async () => {
    const { ctx } = ctxWith([[], []])
    const both = (await tool('iedb_search_assays').run!(ctx as never, {
      structure_iri: 'IEDB_EPITOPE:31803'
    })) as Record<string, unknown>
    expect((both.notes as string[]).join(' ')).toContain('t-cell or b-cell assay evidence')

    const single = ctxWith([[assayRow()]])
    await tool('iedb_search_assays').run!(single.ctx as never, {
      structure_iri: 'IEDB_EPITOPE:31803',
      kind: 'tcell'
    })
    expect(single.urls).toHaveLength(1)
    expect(single.urls[0]).toContain('/tcell_search?')
  })

  it('sends each receptor family only the columns the live service actually has (two 42703s taught this)', async () => {
    // Both of these were caught by the live probe, not by a mocked request: `tcell_search` has no
    // `bcell_id`, and `bcell_search` has no `mhc_restriction` — the service rejects the ENTIRE request
    // with 42703 rather than ignoring an unknown column, so a shared select list cannot work.
    const { ctx, urls } = ctxWith([
      [assayRow()],
      [assayRow({ tcell_id: null, tcell_iri: null, bcell_id: 7, bcell_iri: 'IEDB_BCELL:7' })]
    ])
    await tool('iedb_search_assays').run!(ctx as never, { structure_iri: 'IEDB_EPITOPE:31803' })

    const tcellUrl = decodeURIComponent(urls[0]!)
    const bcellUrl = decodeURIComponent(urls[1]!)
    expect(tcellUrl).toContain('select=tcell_id,tcell_iri')
    expect(tcellUrl).toContain('mhc_restriction')
    expect(tcellUrl).not.toContain('bcell_id')
    expect(bcellUrl).toContain('select=bcell_id,bcell_iri')
    expect(bcellUrl).not.toContain('tcell_id')
    expect(bcellUrl).not.toContain('mhc_restriction')
  })

  it('refuses an unknown kind and a non-amino-acid sequence before sending anything', async () => {
    const { ctx, urls } = ctxWith([[assayRow()]])
    const run = tool('iedb_search_assays').run!
    await expect(
      run(ctx as never, { structure_iri: 'IEDB_EPITOPE:31803', kind: 'mhc' })
    ).rejects.toThrow(/kind must be "tcell", "bcell" or "both"/)
    await expect(run(ctx as never, { sequence: 'ACGTU?!' })).rejects.toThrow(/position 6 is "\?"/)
    expect(urls).toEqual([])
  })

  it('keeps the marker fields a reader can call out at all null/empty (no invented values)', async () => {
    const { ctx } = ctxWith([
      [
        assayRow({
          mhc_restriction: null,
          mhc_class: null,
          pubmed_id: null,
          journal_name: null,
          direct_ex_vivo_bool: null
        })
      ],
      []
    ])
    const out = (await tool('iedb_search_assays').run!(ctx as never, {
      structure_iri: 'IEDB_EPITOPE:31803'
    })) as { rows: Array<Record<string, unknown>> }
    const row = out.rows[0]!
    expect(row.citation).toMatchObject({ pubmed_id: null, pubmed_url: null, journal: null })
    expect(row.direct_ex_vivo).toBeNull()
  })
})
