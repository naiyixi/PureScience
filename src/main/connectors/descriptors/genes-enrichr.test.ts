import { afterEach, describe, expect, it, vi } from 'vitest'

import { GENES_ENRICHR_TOOLS } from './genes-enrichr'

// The library service answers JSON with a text/html content type and only accepts multipart bodies, so the
// transport assumptions are asserted rather than assumed. The honesty rules are asserted too: nothing here
// may present the service's p-values as verified, and a row about genes we did not submit has to fail by
// name instead of being reported against our list.

const tool = GENES_ENRICHR_TOOLS[0]
const run = tool.run as (ctx: unknown, args: Record<string, unknown>) => Promise<Record<string, unknown>>

type FetchCall = { url: string; body: FormData | undefined }

const installFetch = (
  libraries: Record<string, unknown>,
  options: { listId?: number | undefined; enrichStatus?: number } = {}
): FetchCall[] => {
  const calls: FetchCall[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: init?.body as FormData | undefined })
      if (String(url).includes('addList')) {
        const listId = 'listId' in options ? options.listId : 4242
        return new Response(JSON.stringify(listId === undefined ? {} : { userListId: listId }), {
          status: 200,
          headers: { 'content-type': 'text/html;charset=UTF-8' }
        })
      }
      return new Response(JSON.stringify(libraries), {
        status: options.enrichStatus ?? 200,
        headers: { 'content-type': 'text/html;charset=UTF-8' }
      })
    })
  )
  return calls
}

const row = (
  rank: number,
  term: string,
  p: number,
  genes: string[],
  adjusted = 1e-5
): unknown[] => [rank, term, p, 100.5, 2800.1, genes, adjusted, 0, 0]

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('gene_set_enrichment_libraries', () => {
  it('sends the gene list as multipart, reads JSON served as text/html, and reports terms as the service gave them', async () => {
    const calls = installFetch({
      GO_Biological_Process_2023: [row(1, 'Positive Regulation Of Transcription', 9.6e-8, ['TP53', 'EGFR'])]
    })

    const result = await run({}, { genes: ['TP53', 'EGFR', 'MYC'] })

    expect(calls[0].url).toContain('addList')
    expect(calls[0].body).toBeInstanceOf(FormData)
    expect(String((calls[0].body as FormData).get('list'))).toBe('TP53\nEGFR\nMYC')
    expect(calls[1].url).toContain('backgroundType=GO_Biological_Process_2023')

    const [term] = result.terms as Array<Record<string, unknown>>
    expect(term.term).toBe('Positive Regulation Of Transcription')
    expect(term.pValue).toBeCloseTo(9.6e-8)
    expect(term.adjustedPValue).toBeCloseTo(1e-5)
    // The one thing this tool must never claim: that it recomputed the service's number.
    expect(term.recomputed).toBe(false)
    expect(String(term.recomputeReason)).toContain('no set sizes')
    expect(String((result.summary as { notes: string[] }).notes[0])).toContain('service')
  })

  it('refuses a row whose overlapping genes are not the genes we submitted', async () => {
    installFetch({
      GO_Biological_Process_2023: [row(1, 'Somewhere Else', 1e-9, ['TP53', 'SOMETHING_NOT_SUBMITTED'])]
    })

    await expect(run({}, { genes: ['TP53', 'EGFR'] })).rejects.toThrow(
      /not in the submitted list: SOMETHING_NOT_SUBMITTED/
    )
  })

  it('names the library lookup that carried no term list instead of reporting an empty result', async () => {
    installFetch({ SOME_OTHER_LIBRARY: [row(1, 'x', 1e-3, ['TP53'])] })

    const result = await run({}, { genes: ['TP53'], libraries: ['GO_Biological_Process_2023'] })

    const [outcome] = result.perLibrary as Array<Record<string, unknown>>
    expect(String(outcome.error)).toContain('did not carry a term list')
    expect(String(outcome.error)).toContain('SOME_OTHER_LIBRARY')
    expect(result.terms).toEqual([])
  })

  it('names one failed library and still answers the others', async () => {
    const calls = installFetch({
      GOOD_LIBRARY: [row(1, 'Kept', 1e-4, ['TP53'])]
    })
    vi.mocked(fetch).mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
      void init
      if (String(url).includes('addList')) {
        return new Response(JSON.stringify({ userListId: 7 }))
      }
      if (String(url).includes('BAD_LIBRARY')) {
        return new Response('<html>error</html>', { status: 500 })
      }
      void calls
      return new Response(JSON.stringify({ GOOD_LIBRARY: [row(1, 'Kept', 1e-4, ['TP53'])] }))
    })

    const result = await run({}, { genes: ['TP53'], libraries: ['GO_Biological_Process_2023', 'BAD_LIBRARY'] })

    const outcomes = result.perLibrary as Array<Record<string, unknown>>
    expect(outcomes.map((entry) => entry.library)).toEqual([
      'GO_Biological_Process_2023',
      'BAD_LIBRARY'
    ])
    expect(String(outcomes[0].error)).toContain('did not carry a term list')
    expect(String(outcomes[1].error)).toContain('HTTP 500')
    expect((result.counts as { librariesFailed: number }).librariesFailed).toBe(2)
  })

  it('counts filtered and capped terms instead of dropping them silently', async () => {
    installFetch({
      GO_Biological_Process_2023: [
        row(1, 'kept', 1e-8, ['TP53'], 1e-6),
        row(2, 'too weak', 0.5, ['TP53'], 0.4),
        row(3, 'too few genes', 1e-9, ['TP53'], 1e-7),
        row(4, 'also kept', 1e-7, ['EGFR'], 1e-6)
      ]
    })

    const result = await run(
      {},
      { genes: ['TP53', 'EGFR'], alpha: 0.05, min_overlap: 1, max_terms: 1 }
    )

    const counts = result.counts as Record<string, number>
    expect(counts.returned).toBe(4)
    expect(counts.kept).toBe(1)
    expect(counts.filtered).toBe(1)
    // Three terms survive alpha/min_overlap and the cap keeps one, so two are cut — and counted.
    expect(counts.truncated).toBe(2)
    expect(String((result.summary as { notes: string[] }).notes.join(' '))).toContain('filtered out')
    expect(String((result.summary as { notes: string[] }).notes.join(' '))).toContain('per-library cap')
  })

  it('fails by name when the service returns no user list id', async () => {
    installFetch({}, { listId: undefined })

    await expect(run({}, { genes: ['TP53'] })).rejects.toThrow(/did not return a user list id/)
  })

  it('refuses a submission without genes', async () => {
    installFetch({})

    await expect(run({}, { genes: [] })).rejects.toThrow(/at least one gene/)
  })
})
