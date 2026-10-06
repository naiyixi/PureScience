import { describe, it, expect, vi } from 'vitest'
import { ParserEngine } from '../engine'
import { DRUG_REGULATORY_TOOLS } from './drug-regulatory'
import type { ToolDescriptor } from '../types'

const tool = (id: string): ToolDescriptor => DRUG_REGULATORY_TOOLS.find((t) => t.id === id)!

const okJson = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body }) as Response
// openFDA answers a zero-hit search with HTTP 404.
const notFound = (): Response =>
  ({
    ok: false,
    status: 404,
    headers: { get: () => null },
    json: async () => ({})
  }) as unknown as Response

const run = async (
  args: Record<string, unknown>,
  responses: Response[]
): Promise<{ out: Record<string, unknown>; urls: string[] }> => {
  const fetchImpl = vi.fn()
  for (const r of responses) fetchImpl.mockResolvedValueOnce(r)
  const out = (await new ParserEngine({ fetchImpl }).call(
    tool('search_drug_adverse_events'),
    args,
    {}
  )) as Record<string, unknown>
  return { out, urls: fetchImpl.mock.calls.map((c) => c[0] as string) }
}

const EVENTS = 'https://api.fda.gov/drug/event.json'

// Live 2026-10 drug/event record shape. `serious` is a STRING here (openFDA returns it as a string
// on many records, a number on others) — the tool must coerce it. The drug carries an openfda
// harmonisation block in the raw payload, which the tool deliberately drops.
const REPORT = {
  safetyreportid: '10003304',
  receivedate: '20140312',
  serious: '2',
  occurcountry: 'US',
  patient: {
    patientsex: 2,
    patientonsetage: '62',
    patientonsetageunit: '801',
    reaction: [{ reactionmeddrapt: 'NAUSEA', reactionoutcome: '6' }],
    drug: [
      {
        medicinalproduct: 'ASPIRIN',
        drugcharacterization: '1',
        openfda: { brand_name: ['ASPIRIN'], generic_name: ['ASPIRIN'] }
      }
    ]
  }
}

describe('drug_regulatory / search_drug_adverse_events', () => {
  it('ANDs drug + reaction and shapes the report', async () => {
    const { out, urls } = await run({ drug: 'ASPIRIN', reaction: 'NAUSEA' }, [
      okJson({ meta: { last_updated: '2026-07-30', results: { total: 31948 } }, results: [REPORT] })
    ])
    expect(urls[0]).toBe(
      `${EVENTS}?search=${encodeURIComponent(
        'patient.drug.medicinalproduct:"ASPIRIN" AND patient.reaction.reactionmeddrapt:"NAUSEA"'
      )}&limit=25&skip=0`
    )
    expect(out).toEqual({
      search:
        'patient.drug.medicinalproduct:"ASPIRIN" AND patient.reaction.reactionmeddrapt:"NAUSEA"',
      total: 31948,
      n_returned: 1,
      truncated: true,
      last_updated: '2026-07-30',
      note: 'FAERS reports have no exposure denominator — these are report counts, not incidence rates.',
      events: [
        {
          safety_report_id: '10003304',
          receive_date: '20140312',
          country: 'US',
          serious: false,
          seriousness_code: 2,
          patient: { sex: 'female', age: '62', age_unit: '801', n_drugs: 1, n_reactions: 1 },
          drugs: [{ medicinal_product: 'ASPIRIN', characterization: '1' }],
          reactions: [{ term: 'NAUSEA', outcome: '6' }]
        }
      ]
    })
  })

  it('coerces the string serious code and flags a serious report', async () => {
    const { out } = await run({ drug: 'ASPIRIN' }, [
      okJson({ meta: { results: { total: 1 } }, results: [{ ...REPORT, serious: '1' }] })
    ])
    expect((out.events as Array<Record<string, unknown>>)[0]).toMatchObject({
      serious: true,
      seriousness_code: 1
    })
  })

  it('maps seriousness onto the openFDA serious code', async () => {
    const serious = await run({ drug: 'ASPIRIN', seriousness: 'serious' }, [
      okJson({ meta: { results: { total: 1 } }, results: [REPORT] })
    ])
    expect(serious.urls[0]).toBe(
      `${EVENTS}?search=${encodeURIComponent('patient.drug.medicinalproduct:"ASPIRIN" AND serious:1')}&limit=25&skip=0`
    )
    const nonSerious = await run({ drug: 'ASPIRIN', seriousness: 'non-serious' }, [
      okJson({ meta: { results: { total: 1 } }, results: [REPORT] })
    ])
    expect(decodeURIComponent(nonSerious.urls[0]!)).toContain('serious:2')
  })

  it('wraps the mapped filters in parens when a receive-date range is ANDed on', async () => {
    const { urls } = await run(
      { drug: 'ASPIRIN', receivedate_from: '2014-01-01', receivedate_to: '2014-12-31' },
      [okJson({ meta: { results: { total: 1 } }, results: [REPORT] })]
    )
    expect(decodeURIComponent(urls[0]!)).toContain(
      '(patient.drug.medicinalproduct:"ASPIRIN") AND receivedate:[20140101 TO 20141231]'
    )
  })

  it('lets raw_search override the mapped filters', async () => {
    const { urls } = await run({ raw_search: 'serious:1', drug: 'IGNORED' }, [
      okJson({ meta: { results: { total: 1 } }, results: [REPORT] })
    ])
    expect(decodeURIComponent(urls[0]!)).toContain('search=serious:1&')
    expect(decodeURIComponent(urls[0]!)).not.toContain('IGNORED')
  })

  it('treats a zero-hit 404 as an empty (not failing) result', async () => {
    const { out } = await run({ drug: 'ZZZZNOTADRUG' }, [notFound()])
    expect(out).toEqual({
      search: 'patient.drug.medicinalproduct:"ZZZZNOTADRUG"',
      total: 0,
      n_returned: 0,
      truncated: false,
      last_updated: undefined,
      note: 'FAERS reports have no exposure denominator — these are report counts, not incidence rates.',
      events: []
    })
  })
})

// Live self-test against the real openFDA service. Off by default; run with LIVE_API=1.
describe.skipIf(!process.env.LIVE_API)(
  'drug_regulatory / search_drug_adverse_events (LIVE)',
  () => {
    it('returns real FAERS reports for aspirin + nausea', async () => {
      const out = (await new ParserEngine({ timeoutMs: 120_000 }).call(
        tool('search_drug_adverse_events'),
        { drug: 'ASPIRIN', reaction: 'NAUSEA', max_records: 2 },
        {}
      )) as Record<string, unknown>
      expect(Number(out.total)).toBeGreaterThan(0)
      expect((out.events as unknown[]).length).toBeGreaterThan(0)
    }, 60_000)
  }
)
