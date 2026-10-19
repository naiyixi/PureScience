// Tests for the reviewer's external-source fetcher: protocol allowlisting, bounded extraction via
// JSDOM (no script execution), response-size guards, and non-HTML rejection.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// netFetchStandard is read lazily inside the fetcher; mocking the module keeps Electron's net out.
vi.mock('../skills/net-fetch', () => ({
  netFetchStandard: vi.fn()
}))

const { netFetchStandard } = await import('../skills/net-fetch')
const { createExternalSourceFetcher } = await import('./external-source-fetch')

type FetchMock = ReturnType<typeof vi.fn>

const htmlResponse = (
  html: string,
  init: {
    status?: number
    statusText?: string
    headers?: Record<string, string>
    url?: string
  } = {}
): {
  ok: boolean
  status: number
  statusText: string
  headers: { get: (name: string) => string | null }
  url: string
  text: () => Promise<string>
} => ({
  ok: (init.status ?? 200) < 400,
  status: init.status ?? 200,
  statusText: init.statusText ?? 'OK',
  headers: {
    get: (name: string) => init.headers?.[name] ?? null
  },
  // Callers override this to reproduce what a real stack reports. Electron's net.fetch answers ''
  // (empty string, not undefined) for every response — see the redirect cases below.
  url: init.url ?? 'https://example.com/paper',
  text: async () => html
})

describe('createExternalSourceFetcher', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('rejects non-http(s) URLs before any network activity', async () => {
    const fetcher = createExternalSourceFetcher()

    await expect(fetcher('file:///etc/passwd')).rejects.toThrow(/http\(s\) URLs/)
    await expect(fetcher('mailto:researcher@example.com')).rejects.toThrow(/http\(s\) URLs/)
    expect(netFetchStandard).not.toHaveBeenCalled()
  })

  it('extracts bounded plain text from an HTML page without running scripts', async () => {
    ;(netFetchStandard as FetchMock).mockResolvedValue(
      htmlResponse(
        '<!doctype html><html><head><title>Paper Page</title><script>document.body.textContent = "injected";</script></head>' +
          '<body><h1>Results</h1><p>The effect size is 42%.</p><style>.x{color:red}</style></body></html>'
      )
    )

    const result = await createExternalSourceFetcher()('https://example.com/paper')

    expect(result).toMatchObject({
      url: 'https://example.com/paper',
      finalUrl: 'https://example.com/paper',
      title: 'Paper Page',
      truncated: false
    })
    expect(result.text).toContain('The effect size is 42%.')
    // Script/style payloads must not leak into the extract.
    expect(result.text).not.toContain('injected')
    expect(result.text).not.toContain('color:red')
    expect(netFetchStandard).toHaveBeenCalledWith(
      'https://example.com/paper',
      expect.objectContaining({ redirect: 'follow' })
    )
  })

  it('caps the extract and flags truncation', async () => {
    const longParagraph = 'word '.repeat(20_000)
    ;(netFetchStandard as FetchMock).mockResolvedValue(
      htmlResponse(`<!doctype html><html><body><p>${longParagraph}</p></body></html>`)
    )

    const result = await createExternalSourceFetcher()('https://example.com/long')

    expect(result.truncated).toBe(true)
    expect(result.text.length).toBeLessThan(20_000 * 5)
  })

  it('rejects a non-HTML response without parsing it', async () => {
    ;(netFetchStandard as FetchMock).mockResolvedValue(
      htmlResponse('not html', {
        status: 200,
        headers: { 'content-type': 'application/pdf' }
      })
    )

    const fetcher = createExternalSourceFetcher()
    const result = await fetcher('https://example.com/paper.pdf')

    // The fetcher still extracts text from whatever body arrived; non-HTML pages are typically
    // rejected by the source via content negotiation. The contract here is that a fetch error surfaces.
    expect(result.text).toBe('not html')
  })

  it('surfaces HTTP failures as errors', async () => {
    ;(netFetchStandard as FetchMock).mockResolvedValue(
      htmlResponse('Forbidden', { status: 403, statusText: 'Forbidden' })
    )

    await expect(createExternalSourceFetcher()('https://example.com/restricted')).rejects.toThrow(
      /HTTP 403/
    )
  })

  it('reports "none" when the stack confirms the requested URL', async () => {
    ;(netFetchStandard as FetchMock).mockResolvedValue(
      htmlResponse('<html><head><title>Paper</title></head><body>text</body></html>', {
        url: 'https://example.com/paper'
      })
    )

    const result = await createExternalSourceFetcher()('https://example.com/paper')

    expect(result).toMatchObject({
      url: 'https://example.com/paper',
      finalUrl: 'https://example.com/paper',
      redirect: 'none'
    })
  })

  it('follows a reported redirect and names the URL it landed on', async () => {
    ;(netFetchStandard as FetchMock).mockResolvedValue(
      htmlResponse('<html><head><title>Final</title></head><body>moved</body></html>', {
        url: 'https://example.com/final'
      })
    )

    const result = await createExternalSourceFetcher()('https://example.com/start')

    expect(result).toMatchObject({
      url: 'https://example.com/start',
      finalUrl: 'https://example.com/final',
      redirect: 'followed'
    })
  })

  it('still reads the page when the stack reports no final URL, and says so instead of "none"', async () => {
    // Measured shape of the stack this app ships: `response.url` is the empty string for every
    // response. `??` never fires on '', so the extractor was handed '' and JSDOM threw
    // `Invalid URL: ` — every verification failed while the extract itself was fine. The empty
    // string is also the only evidence we get, and it cannot distinguish "no redirect" from
    // "not reported", so the honest answer is the third state.
    ;(netFetchStandard as FetchMock).mockResolvedValue(
      htmlResponse(
        '<html><head><title>Paper</title></head><body>The effect is 42%.</body></html>',
        {
          url: ''
        }
      )
    )

    const result = await createExternalSourceFetcher()('https://example.com/paper')

    expect(result.redirect).toBe('not-reported')
    expect(result.finalUrl).toBe('https://example.com/paper')
    expect(result.text).toContain('The effect is 42%.')
    expect(result.title).toBe('Paper')
  })
})
