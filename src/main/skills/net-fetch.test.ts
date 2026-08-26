import { describe, expect, it, vi, beforeEach } from 'vitest'

const fetchMock = vi.fn()
vi.mock('electron', () => ({ net: { fetch: fetchMock } }))

const { netFetch } = await import('./net-fetch')

describe('netFetch', () => {
  beforeEach(() => fetchMock.mockReset())

  it('delegates to Electron net.fetch with the given url and init', async () => {
    const response = { ok: true, status: 200 }
    fetchMock.mockResolvedValue(response)

    const init = { headers: { 'User-Agent': 'purescience' } }
    const result = await netFetch('https://api.github.com/repos/o/r', init)

    // The correlation wrapper preserves the caller's headers and adds its own x-request-id.
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.github.com/repos/o/r',
      expect.objectContaining({
        headers: expect.objectContaining({
          'User-Agent': 'purescience',
          'x-request-id': expect.stringMatching(/^req-[a-f0-9]{8}$/)
        })
      })
    )
    expect(result).toBe(response)
  })

  it('propagates the Chromium network stack status (e.g. proxy-routed success)', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 })

    const result = await netFetch('https://api.github.com/repos/o/r/git/trees/main?recursive=1')

    expect(result.ok).toBe(true)
    expect(result.status).toBe(200)
  })
})
