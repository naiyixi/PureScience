import { describe, expect, it, vi } from 'vitest'

import { ParserEngine } from '../engine'
import type { ToolDescriptor } from '../types'
import { PROTEOMICS_PDC_TOOLS } from './proteomics-pdc'

const tool = (id: string): ToolDescriptor => PROTEOMICS_PDC_TOOLS.find((t) => t.id === id)!

const jsonRes = (body: unknown): Response =>
  ({
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body)
  }) as unknown as Response

const UUID = '28f0e1de-c04b-4281-981d-865a5885245e'

describe('proteomics-pdc / pdc_studies', () => {
  it('returns the service study catalogue and reports truncation from its own row count', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonRes({
        data: {
          uiStudySummary: [
            {
              study_id: UUID,
              study_name: 'Academia Sinica BRCA - Phosphoproteome',
              disease_type: 'Breast Invasive Carcinoma;Not Reported',
              primary_site: 'Breast;Not Reported'
            },
            {
              study_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
              study_name: 'CPTAC LUAD',
              disease_type: 'Lung Adenocarcinoma',
              primary_site: 'Lung'
            }
          ]
        }
      })
    )
    const out = (await new ParserEngine({ fetchImpl }).call(
      tool('pdc_studies'),
      { max_studies: 1 },
      {}
    )) as {
      n_studies_returned: number
      truncated: boolean
      studies: Array<{ study_id: string; study_name: string }>
    }
    const posted = JSON.parse(String((fetchImpl.mock.calls[0][1] as RequestInit).body)) as {
      query: string
    }

    expect(posted.query).toContain('uiStudySummary')
    expect(out.n_studies_returned).toBe(1)
    expect(out.truncated).toBe(true)
    expect(out.studies[0].study_id).toBe(UUID)
  })

  it('raises a service GraphQL error by name instead of returning an empty catalogue', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonRes({ errors: [{ message: 'Cannot query field "nope" on type "Query".' }] })
      )
    const out = (await new ParserEngine({ fetchImpl }).call(tool('pdc_studies'), {}, {})) as {
      error: string
      message: string
      studies?: unknown
    }

    expect(out.error).toBe('graphql-error')
    expect(out.message).toContain('Cannot query field')
    expect(out.studies).toBeUndefined()
  })
})

describe('proteomics-pdc / pdc_study_files', () => {
  it('reports the study own file count, the bytes of the rows returned, and the page it took', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonRes({
        data: {
          filesPerStudy: [
            {
              file_name: 'a.raw',
              file_size: '2463272988',
              file_format: 'vendor-specific',
              file_type: 'Proprietary'
            },
            {
              file_name: 'b.raw',
              file_size: '2380184078',
              file_format: 'vendor-specific',
              file_type: 'Proprietary'
            }
          ],
          filesCountPerStudy: [{ files_count: 600 }]
        }
      })
    )
    const out = (await new ParserEngine({ fetchImpl }).call(
      tool('pdc_study_files'),
      { study_id: UUID, limit: 2 },
      {}
    )) as {
      total_files: number
      n_files_returned: number
      bytes_of_returned_rows: number
      truncated: boolean
      files: Array<{ file_name: string; file_size: string }>
    }
    const posted = JSON.parse(String((fetchImpl.mock.calls[0][1] as RequestInit).body)) as {
      variables: { studyId: string; offset: number; limit: number }
    }

    expect(posted.variables).toEqual({ studyId: UUID, offset: 0, limit: 2 })
    expect(out.total_files).toBe(600)
    expect(out.n_files_returned).toBe(2)
    // The sum is over the rows this call returned, and it is exact arithmetic on the service's own strings.
    expect(out.bytes_of_returned_rows).toBe(2463272988 + 2380184078)
    expect(out.truncated).toBe(true)
  })

  it('refuses a PDC accession by name before any request, because the service rejects it', async () => {
    const fetchImpl = vi.fn()
    const out = (await new ParserEngine({ fetchImpl }).call(
      tool('pdc_study_files'),
      { study_id: 'PDC000127' },
      {}
    )) as {
      error: string
      message: string
    }

    expect(out.error).toBe('invalid-study-id')
    expect(out.message).toContain('UUID')
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
