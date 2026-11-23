import { describe, expect, it } from 'vitest'

import { fetchManifestText } from './language-pack-fetch'

// Why these cases exist: on 2026-11-23 a Windows runner could not reach `github.com` at all
// (`net::ERR_CONNECTION_TIMED_OUT` on the runtime manifest) and first-run provisioning failed having asked
// exactly one host — while the pack archive's own download path already had a mirror fallback. The manifest
// carries the digests, so its fallback is the one that has to be *right*, not merely present:
//
//   1. origin is asked first and wins whenever it answers (mirrors are for reachability, not correctness);
//   2. a mirror is only consulted when the origin did not answer;
//   3. when nothing answers, the error names every host and what each one said — the runtime must not be
//      blamed for a host that was silent.

const MANIFEST_URL =
  'https://github.com/naiyixi/PureScience/releases/download/runtime-v1/osx-arm64-manifest.json'
const PROXY_URL = `https://gh-proxy.com/${MANIFEST_URL}`

describe('the runtime manifest walks the same hosts the archive download does', () => {
  it('asks the origin first and never consults a mirror when the origin answers', async () => {
    const asked: string[] = []
    const result = await fetchManifestText(MANIFEST_URL, undefined, {
      candidates: () => [{ url: PROXY_URL, host: 'gh-proxy.com' }],
      fetchStandard: async (url) => {
        asked.push(url)
        return { ok: true, status: 200, text: async () => '{"schema":1}' }
      }
    })

    expect(asked).toEqual([MANIFEST_URL])
    expect(result).toEqual({ text: '{"schema":1}', via: 'github.com' })
  })

  it('asks our own host before the origin, because its bytes are ours and it is the fast hop', async () => {
    // A China first run used to spend the whole 30 s manifest timeout against github.com before reaching any
    // mirror. The vendor copy is not a third party: it is the same bytes we publish, so it may be asked
    // first, and `via` still names it so the progress line says where the document came from.
    const asked: string[] = []
    const result = await fetchManifestText(MANIFEST_URL, undefined, {
      candidates: () => [
        {
          url: 'https://purescience.work/download/runtime/osx-arm64-manifest.json',
          host: 'purescience.work'
        },
        { url: PROXY_URL, host: 'gh-proxy.com' }
      ],
      fetchStandard: async (url) => {
        asked.push(url)
        return { ok: true, status: 200, text: async () => `{"served":"${url}"}` }
      }
    })

    expect(asked).toEqual(['https://purescience.work/download/runtime/osx-arm64-manifest.json'])
    expect(result.via).toBe('purescience.work')
  })

  it('falls back to a mirror when the origin does not answer, and names the host that served it', async () => {
    const asked: string[] = []
    const result = await fetchManifestText(MANIFEST_URL, undefined, {
      candidates: () => [{ url: PROXY_URL, host: 'gh-proxy.com' }],
      fetchStandard: async (url) => {
        asked.push(url)
        if (url === MANIFEST_URL) throw new Error('net::ERR_CONNECTION_TIMED_OUT')
        return { ok: true, status: 200, text: async () => '{"schema":1,"from":"proxy"}' }
      }
    })

    expect(asked).toEqual([MANIFEST_URL, PROXY_URL])
    // `via` is the host, not 'origin': the caller's progress line prints it, so a fallback cannot read as
    // an origin download.
    expect(result.via).toBe('gh-proxy.com')
    expect(result.text).toContain('proxy')
  })

  it('treats a non-2xx origin answer as a reason to try the next host, not as the end', async () => {
    const result = await fetchManifestText(MANIFEST_URL, undefined, {
      candidates: () => [{ url: PROXY_URL, host: 'gh-proxy.com' }],
      fetchStandard: async (url) =>
        url === MANIFEST_URL
          ? { ok: false, status: 503, text: async () => '' }
          : { ok: true, status: 200, text: async () => '{"schema":1}' }
    })

    expect(result.via).toBe('gh-proxy.com')
  })

  it('names every host and its reason when nothing answers', async () => {
    const failure = fetchManifestText(MANIFEST_URL, undefined, {
      candidates: () => [
        { url: PROXY_URL, host: 'gh-proxy.com' },
        { url: 'https://ghfast.top/x', host: 'ghfast.top' }
      ],
      fetchStandard: async (url) => {
        if (url === MANIFEST_URL) throw new Error('net::ERR_CONNECTION_TIMED_OUT')
        if (url === PROXY_URL) return { ok: false, status: 502, text: async () => '' }
        throw new Error('connect timeout')
      }
    })

    await expect(failure).rejects.toThrow(
      /runtime manifest request failed \(github\.com: net::ERR_CONNECTION_TIMED_OUT; gh-proxy\.com answered 502; ghfast\.top: connect timeout\)/
    )
  })
})
