import { describe, it, expect, vi } from 'vitest'
import { ParserEngine } from '../engine'
import { CANCER_MODELS_TOOLS } from './cancer-models'
import type { ToolDescriptor } from '../types'

const tool = (id: string): ToolDescriptor => CANCER_MODELS_TOOLS.find((t) => t.id === id)!

const okJson = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body }) as Response
const notFound = (): Response =>
  ({
    ok: false,
    status: 404,
    headers: { get: () => null },
    json: async () => ({})
  }) as unknown as Response

type Call = [string, (RequestInit & { body?: string }) | undefined]

const run = async (
  args: Record<string, unknown>,
  responses: Response[]
): Promise<{ out: Record<string, unknown>; calls: Call[] }> => {
  const fetchImpl = vi.fn()
  for (const r of responses) fetchImpl.mockResolvedValueOnce(r)
  const out = (await new ParserEngine({ fetchImpl }).call(
    tool('cbioportal_structural_variants_in_gene'),
    args,
    {}
  )) as Record<string, unknown>
  return { out, calls: fetchImpl.mock.calls as unknown as Call[] }
}

const CBIOPORTAL = 'https://www.cbioportal.org/api'
const STUDY = 'acc_tcga_pan_can_atlas_2018'
const PROFILE = `${STUDY}_structural_variants`

const GENE = { entrezGeneId: 3481, hugoGeneSymbol: 'IGF2', type: 'protein-coding' }
const PROFILES = [
  {
    molecularProfileId: PROFILE,
    studyId: STUDY,
    molecularAlterationType: 'STRUCTURAL_VARIANT',
    datatype: 'SV',
    name: 'Structural variants'
  }
]

// Live 2026-10 /structural-variant/fetch rows (trimmed), gene-filtered on IGF2.
const SV_ROWS = [
  {
    molecularProfileId: PROFILE,
    sampleId: 'TCGA-PK-A5H9-01',
    patientId: 'TCGA-PK-A5H9',
    site1EntrezGeneId: 116985,
    site1HugoSymbol: 'ARAP1',
    site1Chromosome: '11',
    site1Position: 72722065,
    site2EntrezGeneId: 3481,
    site2HugoSymbol: 'IGF2',
    site2Chromosome: '11',
    site2Position: 2132106,
    ncbiBuild: 'GRCh37',
    eventInfo: 'ARAP1-IGF2 fusion',
    svStatus: 'SOMATIC'
  },
  {
    molecularProfileId: PROFILE,
    sampleId: 'TCGA-PK-A5H9-01',
    patientId: 'TCGA-PK-A5H9',
    site1EntrezGeneId: 23277,
    site1HugoSymbol: 'CLUH',
    site2EntrezGeneId: 3481,
    site2HugoSymbol: 'IGF2',
    eventInfo: 'CLUH-IGF2 fusion',
    svStatus: 'SOMATIC'
  },
  {
    molecularProfileId: PROFILE,
    sampleId: 'TCGA-XX-0001-01',
    patientId: 'TCGA-XX-0001',
    site1EntrezGeneId: 3481,
    site1HugoSymbol: 'IGF2',
    site2EntrezGeneId: 116985,
    site2HugoSymbol: 'ARAP1',
    eventInfo: 'NA',
    svStatus: 'SOMATIC'
  }
]

describe('cancer_models / cbioportal_structural_variants_in_gene', () => {
  it('resolves the gene + SV profile, POSTs a gene-filtered fetch, and maps both sides', async () => {
    const { out, calls } = await run({ gene_symbol: 'IGF2', study_id: STUDY }, [
      okJson(GENE),
      okJson(PROFILES),
      okJson(SV_ROWS)
    ])
    expect(calls.map((c) => c[0])).toEqual([
      `${CBIOPORTAL}/genes/IGF2`,
      `${CBIOPORTAL}/studies/${STUDY}/molecular-profiles`,
      `${CBIOPORTAL}/structural-variant/fetch`
    ])
    // The request body is the reader-facing server-side filter: the resolved profile + the gene's
    // Entrez id (not the symbol).
    expect(calls[2]![1]?.method).toBe('POST')
    expect(JSON.parse(String(calls[2]![1]?.body))).toEqual({
      molecularProfileIds: [PROFILE],
      entrezGeneIds: [3481]
    })
    expect(out).toEqual({
      gene: { symbol: 'IGF2', entrez_gene_id: 3481 },
      study_id: STUDY,
      molecular_profile_id: PROFILE,
      total_events: 3,
      altered_sample_count: 2,
      distinct_fusions: 3,
      truncated: false,
      fusions: [
        { fusion: 'ARAP1-IGF2', count: 1 },
        { fusion: 'CLUH-IGF2', count: 1 },
        { fusion: 'IGF2-ARAP1', count: 1 }
      ],
      events: [
        {
          sample_id: 'TCGA-PK-A5H9-01',
          patient_id: 'TCGA-PK-A5H9',
          site1_gene: 'ARAP1',
          site1_entrez_gene_id: 116985,
          site2_gene: 'IGF2',
          site2_entrez_gene_id: 3481,
          fusion: 'ARAP1-IGF2',
          sv_status: 'SOMATIC',
          chromosome1: '11',
          position1: 72722065,
          chromosome2: '11',
          position2: 2132106,
          ncbi_build: 'GRCh37'
        },
        {
          sample_id: 'TCGA-PK-A5H9-01',
          patient_id: 'TCGA-PK-A5H9',
          site1_gene: 'CLUH',
          site1_entrez_gene_id: 23277,
          site2_gene: 'IGF2',
          site2_entrez_gene_id: 3481,
          fusion: 'CLUH-IGF2',
          sv_status: 'SOMATIC',
          chromosome1: undefined,
          position1: undefined,
          chromosome2: undefined,
          position2: undefined,
          ncbi_build: undefined
        },
        {
          sample_id: 'TCGA-XX-0001-01',
          patient_id: 'TCGA-XX-0001',
          site1_gene: 'IGF2',
          site1_entrez_gene_id: 3481,
          site2_gene: 'ARAP1',
          site2_entrez_gene_id: 116985,
          fusion: 'IGF2-ARAP1',
          sv_status: 'SOMATIC',
          chromosome1: undefined,
          position1: undefined,
          chromosome2: undefined,
          position2: undefined,
          ncbi_build: undefined
        }
      ]
    })
  })

  it('caps events at max_records and flags truncation', async () => {
    const { out } = await run({ gene_symbol: 'IGF2', study_id: STUDY, max_records: 1 }, [
      okJson(GENE),
      okJson(PROFILES),
      okJson(SV_ROWS)
    ])
    expect(out).toMatchObject({ total_events: 3, distinct_fusions: 3, truncated: true })
    expect((out.events as unknown[]).length).toBe(1)
  })

  it('names a study without structural-variant data, listing the types it does have', async () => {
    await expect(
      run({ gene_symbol: 'IGF2', study_id: 'brca_tcga' }, [
        okJson(GENE),
        okJson([
          {
            molecularProfileId: 'brca_tcga_mutations',
            molecularAlterationType: 'MUTATION_EXTENDED',
            datatype: 'MAF'
          }
        ])
      ])
    ).rejects.toThrow(
      /has no structural-variant data.*Available alteration types: MUTATION_EXTENDED/s
    )
  })

  it('propagates a named "Gene not found" from the resolver', async () => {
    await expect(run({ gene_symbol: 'NOPE', study_id: STUDY }, [notFound()])).rejects.toThrow(
      /Gene not found: NOPE/
    )
  })
})

// Live self-test against the real cBioPortal service. Off by default; run with LIVE_API=1.
describe.skipIf(!process.env.LIVE_API)(
  'cancer_models / cbioportal_structural_variants_in_gene (LIVE)',
  () => {
    it('returns real fusion events for IGF2 in the ACC pan-cancer study', async () => {
      const out = (await new ParserEngine({ timeoutMs: 120_000 }).call(
        tool('cbioportal_structural_variants_in_gene'),
        { gene_symbol: 'IGF2', study_id: 'acc_tcga_pan_can_atlas_2018', max_records: 5 },
        {}
      )) as Record<string, unknown>
      expect(out.study_id).toBe('acc_tcga_pan_can_atlas_2018')
      expect(String(out.molecular_profile_id)).toContain('structural_variants')
      expect(Number(out.total_events)).toBeGreaterThan(0)
    }, 60_000)
  }
)
