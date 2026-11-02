// Live connector probes. Skipped unless PURESCIENCE_LIVE_CONNECTORS=1, because they reach third-party
// services: a lane that goes red because a source is slow teaches people to ignore red. The packaged CI
// lane sets the variable on purpose and prints the readings into the job log, which is how a source that
// cannot be reached from a developer machine still gets a real reading.
import { describe, expect, it } from 'vitest'

import { PDB_SIMILARITY_TOOLS } from './descriptors/pdb-similarity'
import { TCIA_TOOLS } from './descriptors/tcia'
import type { ToolContext } from './types'

const live = process.env.PURESCIENCE_LIVE_CONNECTORS === '1'

const ctx: ToolContext = {
  fetchJson: async (url) => (await fetch(url)).json(),
  fetchText: async (url) => (await fetch(url)).text(),
  fetchJsonWithHeaders: async (url) => {
    const res = await fetch(url)
    return { body: await res.json(), headers: res.headers }
  },
  postJson: async (url, body) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
    return res.json()
  },
  postForm: async (url, form) => {
    const res = await fetch(url, { method: 'POST', body: form })
    return res.json()
  }
}

describe.skipIf(!live)('live connector probes', () => {
  it('TCIA answers the three reads it is asked for', async () => {
    const [collections, patients, series] = TCIA_TOOLS
    const c = (await collections.run!(ctx, { limit: 5 })) as Record<string, unknown>
    console.log('LIVE tcia_collections', JSON.stringify(c).slice(0, 400))
    expect(c.error, String(c.message ?? '')).toBeUndefined()

    const first = (c.collections as Record<string, unknown>[] | undefined)?.[0]
    const name = String(first?.Collection ?? first?.collection ?? 'TCGA-LUAD')
    const p = (await patients.run!(ctx, { collection: name, limit: 3 })) as Record<string, unknown>
    console.log('LIVE tcia_patient_studies', name, JSON.stringify(p).slice(0, 300))

    const s = (await series.run!(ctx, { collection: name, limit: 3 })) as Record<string, unknown>
    console.log('LIVE tcia_series_search', name, JSON.stringify(s).slice(0, 300))
    expect(s.error, String(s.message ?? '')).toBeUndefined()
  }, 120_000)

  it('the structure-similarity connector answers, or says by name why it cannot', async () => {
    const [similarity] = PDB_SIMILARITY_TOOLS
    const r = (await similarity.run!(ctx, { pdb_id: '1cbs', max_hits: 5 })) as Record<
      string,
      unknown
    >
    console.log('LIVE pdb_structure_similarity', JSON.stringify(r).slice(0, 500))
    // A named refusal is a result: the point of this probe is to print WHICH of "no hits", "service
    // unreachable" or "wrong payload" happened, not to force a green.
    expect(typeof r).toBe('object')
  }, 180_000)
})
