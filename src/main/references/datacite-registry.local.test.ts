import { describe, expect, it } from 'vitest'

import { checkDoiIntegrity } from './doi-integrity'
import { fetchReferenceByIdentifier } from './service'

// Real network, real registry. Run explicitly:
//
//   VITEST_LOCAL=1 npx vitest run src/main/references/datacite-registry.local.test.ts
//
// It asks the two registration agencies through the product's own functions — no mock, no fixture — and
// prints what came back. The point is not that a mock can be wired: it is that a dataset DOI (Zenodo) and
// a preprint DOI (arXiv) resolve in this library at all, while the Crossref-only integrity check says out
// loud which registry holds them instead of implying the identifier is bad.

const ZENODO_DOI = '10.5281/zenodo.8300489'
const ARXIV_DOI = '10.48550/arXiv.1706.03762'
const CROSSREF_DOI = '10.1038/nature14539'

describe.skipIf(process.env.VITEST_LOCAL !== '1')('registration agencies, live', () => {
  it('resolves a Zenodo dataset DOI through DataCite and names that registry', async () => {
    const record = await fetchReferenceByIdentifier('doi', ZENODO_DOI)
    console.log(
      'ZENODO',
      JSON.stringify({
        title: record?.title,
        venue: record?.venue,
        year: record?.year,
        itemType: record?.itemType,
        connector: record?.sourceConnector,
        sourceUrl: record?.provenance?.sourceUrl,
        snapshotChars: record?.provenance?.snapshotJson?.length
      })
    )
    expect(record).not.toBeNull()
    expect(record?.sourceConnector).toBe('datacite')
    expect(record?.title?.length ?? 0).toBeGreaterThan(0)
    expect(record?.provenance?.sourceUrl).toContain('api.datacite.org')
  }, 60_000)

  it('resolves an arXiv DOI (DataCite) and types it as a preprint', async () => {
    const record = await fetchReferenceByIdentifier('doi', ARXIV_DOI)
    console.log(
      'ARXIV',
      JSON.stringify({
        title: record?.title,
        venue: record?.venue,
        year: record?.year,
        itemType: record?.itemType,
        connector: record?.sourceConnector
      })
    )
    expect(record?.title).toBe('Attention Is All You Need')
    // Measured 2026-11-05: the open index also holds arXiv DOIs, so the first registry answers here and
    // DataCite is only the fallback. Either answer is a real record; what must not happen is "not found"
    // for a DOI that resolves at doi.org — and the connector has to name whichever registry answered.
    expect(['openalex', 'datacite']).toContain(record?.sourceConnector)
    expect(record?.itemType).toBe('preprint')
  }, 60_000)

  it('still answers "not found" for a DOI neither registry holds', async () => {
    const record = await fetchReferenceByIdentifier('doi', '10.9999/definitely-not-registered')
    expect(record).toBeNull()
  }, 60_000)

  it('says which agency holds a DataCite DOI rather than implying the identifier is bad', async () => {
    const verdict = await checkDoiIntegrity(ZENODO_DOI, { fetchImpl: fetch })
    console.log('INTEGRITY-DATACITE', JSON.stringify(verdict))
    // Not 'clean': DataCite publishes no retraction notices, so "not found there" is not "not retracted".
    expect(verdict.status).toBe('unavailable')
    expect(verdict.error).toContain('DataCite')
    expect(verdict.error).toContain('Crossref')
  }, 60_000)

  it('still reads a Crossref DOI end to end', async () => {
    const verdict = await checkDoiIntegrity(CROSSREF_DOI, { fetchImpl: fetch })
    console.log('INTEGRITY-CROSSREF', JSON.stringify(verdict))
    expect(verdict.status).not.toBe('unavailable')
    expect(verdict.sourceUrl).toContain('api.crossref.org')
  }, 60_000)
})
