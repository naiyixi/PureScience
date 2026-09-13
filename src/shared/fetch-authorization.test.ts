// Fetch-domain grants: exact host, www-normalized, fail closed on anything unreadable.
//
// The host list in these cases is the recorded one (the 27 authorization notifications that motivated
// D6), so the scope decision is pinned against real traffic rather than invented examples.
import { describe, expect, it } from 'vitest'

import {
  describeFetchHostGrant,
  fetchHostCategoryKey,
  fetchHostFromCategoryKey,
  fetchHostFromTrustedInput,
  fetchHostFromUrl
} from './fetch-authorization'

describe('fetch host scope', () => {
  it('reads the hosts the recorded authorizations actually asked for', () => {
    expect(fetchHostFromUrl('https://pmc.ncbi.nlm.nih.gov/articles/PMC7549104/')).toBe(
      'pmc.ncbi.nlm.nih.gov'
    )
    expect(
      fetchHostFromUrl('http://cucyc.feilab.net/LSI/NEW-IMAGE?type=REACTION&object=RXN-14987')
    ).toBe('cucyc.feilab.net')
    expect(fetchHostFromUrl('https://patents.google.com/patent/US1234567B2/en')).toBe(
      'patents.google.com'
    )
  })

  it('treats www.example.com and example.com as one grant, and keeps siblings apart', () => {
    expect(fetchHostFromUrl('https://www.freepatentsonline.com/result.html')).toBe(
      'freepatentsonline.com'
    )
    expect(fetchHostFromUrl('https://freepatentsonline.com/result.html')).toBe(
      'freepatentsonline.com'
    )
    // A sibling subdomain is a different host: collapsing to the parent domain would have saved one
    // prompt on this data while silently widening the grant, so it is not done.
    expect(fetchHostFromUrl('https://pubmed.ncbi.nlm.nih.gov/12345/')).not.toBe(
      fetchHostFromUrl('https://pmc.ncbi.nlm.nih.gov/articles/PMC123/')
    )
  })

  it('fails closed on anything it cannot read, leaving the request one-shot', () => {
    expect(fetchHostFromUrl('')).toBeUndefined()
    expect(fetchHostFromUrl('not a url')).toBeUndefined()
    expect(fetchHostFromUrl('file:///etc/passwd')).toBeUndefined()
    expect(fetchHostFromUrl('ftp://example.com/x')).toBeUndefined()
    expect(fetchHostFromUrl('https://intranet/thing')).toBeUndefined()
    // localhost is a real host with no third party to leak to.
    expect(fetchHostFromUrl('http://localhost:8080/x')).toBe('localhost')
  })

  it('round-trips the category key', () => {
    const key = fetchHostCategoryKey('pmc.ncbi.nlm.nih.gov')

    expect(key).toBe('fetch-host:pmc.ncbi.nlm.nih.gov')
    expect(fetchHostFromCategoryKey(key)).toBe('pmc.ncbi.nlm.nih.gov')
    expect(fetchHostFromCategoryKey('shell:ls')).toBeUndefined()
    expect(fetchHostFromCategoryKey('fetch-host:')).toBeUndefined()
  })

  it('takes the host from structured input only, never from the display title', () => {
    expect(fetchHostFromTrustedInput({ url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC1/' })).toBe(
      'pmc.ncbi.nlm.nih.gov'
    )
    expect(fetchHostFromTrustedInput({ uri: 'https://patents.google.com/patent/US1/en' })).toBe(
      'patents.google.com'
    )

    // A title is model-controlled display text: deriving a grant key from it would let the model pick the
    // key it is granted AND the key later requests match, so it is never consulted.
    expect(
      fetchHostFromTrustedInput('Fetch https://patents.google.com/patent/US1/en')
    ).toBeUndefined()
    expect(fetchHostFromTrustedInput({ query: 'cell atlas' })).toBeUndefined()
    expect(fetchHostFromTrustedInput({ url: 'nonsense' })).toBeUndefined()
    expect(fetchHostFromTrustedInput(undefined)).toBeUndefined()
    expect(fetchHostFromTrustedInput(null)).toBeUndefined()
  })

  it('labels a grant so the composer can show and revoke it', () => {
    expect(describeFetchHostGrant('patents.google.com')).toBe('Fetch domain: patents.google.com')
  })
})
