import { describe, expect, it, vi } from 'vitest'

import {
  downloadWithMirrorFallback,
  mirrorCandidatesFor,
  streamWithMirrorFallback
} from './source-mirrors'

describe('mirror candidates (evidence-based table)', () => {
  it('offers the huggingface mirror with the same path', () => {
    expect(
      mirrorCandidatesFor('https://huggingface.co/bert-base-uncased/resolve/main/config.json')
    ).toEqual([
      {
        url: 'https://hf-mirror.com/bert-base-uncased/resolve/main/config.json',
        host: 'hf-mirror.com'
      }
    ])
  })

  it('rewrites a raw.githubusercontent URL into the jsDelivr form', () => {
    expect(
      mirrorCandidatesFor('https://raw.githubusercontent.com/naiyixi/PureScience/main/README.md')
    ).toEqual([
      {
        url: 'https://cdn.jsdelivr.net/gh/naiyixi/PureScience@main/README.md',
        host: 'cdn.jsdelivr.net'
      }
    ])
  })

  it('offers nothing for a raw URL too short to rewrite', () => {
    expect(mirrorCandidatesFor('https://raw.githubusercontent.com/only/three')).toEqual([])
  })

  it('never mirrors a credential-bearing endpoint', () => {
    // Falling back here would hand an API key (or a billable request) to a third party, invisibly.
    expect(mirrorCandidatesFor('https://api.anthropic.com/v1/messages')).toEqual([])
    expect(mirrorCandidatesFor('https://api.deepseek.com/v1/chat/completions')).toEqual([])
  })

  it('offers nothing for hosts the measurement refuted', () => {
    // ftp.wwpdb.org does not resolve here, and ftp.ncbi serves a different service than eutils — neither is a
    // fallback for the other, which is why the table lists only observed-working pairs.
    expect(mirrorCandidatesFor('https://files.rcsb.org/download/1CRN.pdb')).toEqual([])
    expect(mirrorCandidatesFor('https://ftp.ncbi.nlm.nih.gov/genomes/x')).toEqual([])
    expect(
      mirrorCandidatesFor('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi')
    ).toEqual([])
    expect(mirrorCandidatesFor('https://example.org/nothing')).toEqual([])
  })
})

describe('downloadWithMirrorFallback', () => {
  const opts = { expectedSha256: 'a'.repeat(64) }

  it('returns the origin result and says so when the origin works', async () => {
    const download = vi.fn().mockResolvedValue('/tmp/x')
    const result = await downloadWithMirrorFallback(
      'https://huggingface.co/m/resolve/main/f.bin',
      '/tmp/x',
      opts,
      { download }
    )

    expect(result).toEqual({ path: '/tmp/x', via: 'origin' })
    expect(download).toHaveBeenCalledTimes(1)
  })

  it('falls back to the mirror and names where the bytes came from', async () => {
    const download = vi
      .fn()
      .mockRejectedValueOnce(new Error('Connection timed out'))
      .mockResolvedValueOnce('/tmp/x')
    const removeFile = vi.fn().mockResolvedValue(undefined)

    const result = await downloadWithMirrorFallback(
      'https://huggingface.co/m/resolve/main/f.bin',
      '/tmp/x',
      opts,
      { download, removeFile }
    )

    expect(result).toEqual({ path: '/tmp/x', via: 'hf-mirror.com' })
    expect(download.mock.calls[1]?.[0]).toBe('https://hf-mirror.com/m/resolve/main/f.bin')
    // The origin's partial bytes must not be resumed against a different server.
    expect(removeFile).toHaveBeenCalledWith('/tmp/x.part')
  })

  it('asks our own host before the origin for the runtime bundle, and never splices its partials', async () => {
    const runtime =
      'https://github.com/naiyixi/PureScience/releases/download/runtime-v1/win-64-python-3.12.tar.zst'
    const download = vi.fn().mockResolvedValue('/tmp/x')
    const removeFile = vi.fn().mockResolvedValue(undefined)

    const result = await downloadWithMirrorFallback(runtime, '/tmp/x', opts, {
      download,
      removeFile
    })

    expect(download.mock.calls[0]?.[0]).toBe(
      'https://purescience.work/download/runtime/win-64-python-3.12.tar.zst'
    )
    expect(result.via).toBe('purescience.work')
    // The origin was never asked: a host we publish is the fast hop, not a last resort.
    expect(download).toHaveBeenCalledTimes(1)
  })

  it('falls through to the origin when our own host fails, and only then to a third party', async () => {
    const runtime =
      'https://github.com/naiyixi/PureScience/releases/download/runtime-v1/win-64-python-3.12.tar.zst'
    const tried: string[] = []
    const download = vi.fn(async (url: string) => {
      tried.push(url)
      if (url.startsWith('https://purescience.work/')) throw new Error('404')
      if (url === runtime) throw new Error('Connection timed out')
      if (url.startsWith('https://gh-proxy.com/')) throw new Error('502')
      return '/tmp/x'
    })

    const result = await downloadWithMirrorFallback(runtime, '/tmp/x', opts, {
      download,
      removeFile: async () => undefined
    })

    expect(tried).toEqual([
      'https://purescience.work/download/runtime/win-64-python-3.12.tar.zst',
      runtime,
      `https://gh-proxy.com/${runtime}`,
      `https://ghfast.top/${runtime}`
    ])
    expect(result.via).toBe('ghfast.top')
  })

  it('does not fall back at all without a digest — a loud failure beats quiet wrong data', async () => {
    const download = vi.fn().mockRejectedValue(new Error('Connection timed out'))

    await expect(
      downloadWithMirrorFallback(
        'https://huggingface.co/m/resolve/main/f.bin',
        '/tmp/x',
        {},
        { download }
      )
    ).rejects.toThrow('Connection timed out')
    expect(download).toHaveBeenCalledTimes(1)
  })

  it('surfaces the mirror failure when both hops fail', async () => {
    const download = vi
      .fn()
      .mockRejectedValueOnce(new Error('origin down'))
      .mockRejectedValueOnce(new Error('mirror down'))

    await expect(
      downloadWithMirrorFallback('https://huggingface.co/m/resolve/main/f.bin', '/tmp/x', opts, {
        download
      })
    ).rejects.toThrow('mirror down')
    expect(download).toHaveBeenCalledTimes(2)
  })
})

describe('the GitHub release-asset rule (measured 2026-10-17)', () => {
  const asset =
    'https://github.com/naiyixi/PureScience/releases/download/models-v1/structure-recognition-primary.zip'

  it('offers our own copy first, then the two proxies that served byte-identical bytes', () => {
    expect(mirrorCandidatesFor(asset)).toEqual([
      {
        url: 'https://purescience.work/download/models/structure-recognition-primary.zip',
        host: 'purescience.work'
      },
      {
        url: `https://gh-proxy.com/https://github.com/naiyixi/PureScience/releases/download/models-v1/structure-recognition-primary.zip`,
        host: 'gh-proxy.com'
      },
      {
        url: `https://ghfast.top/https://github.com/naiyixi/PureScience/releases/download/models-v1/structure-recognition-primary.zip`,
        host: 'ghfast.top'
      }
    ])
  })

  it('puts our own host first for the runtime bundle, ahead of the third-party proxies', () => {
    // The runtime bundle is the one release we publish twice: byte-identically on our own host. It is
    // listed first because we can vouch for those bytes, and because a first run in China should not have
    // to fail against github.com and a proxy before reaching a copy we control.
    const runtime =
      'https://github.com/naiyixi/PureScience/releases/download/runtime-v1/osx-arm64-python-3.12.tar.zst'
    expect(mirrorCandidatesFor(runtime).map((candidate) => candidate.host)).toEqual([
      'purescience.work',
      'gh-proxy.com',
      'ghfast.top'
    ])
    expect(mirrorCandidatesFor(runtime)[0].url).toBe(
      'https://purescience.work/download/runtime/osx-arm64-python-3.12.tar.zst'
    )
  })

  it('sends the model-weight release asset to our own host, and only that exact path', () => {
    // The weights are the other family we publish ourselves — and the one a Chinese reader hit as
    // `fetch failed` when the first hop was GitHub.
    expect(
      mirrorCandidatesFor(
        'https://github.com/naiyixi/PureScience/releases/download/models-v1/structure-recognition-primary.zip'
      ).map((candidate) => candidate.url)
    ).toEqual([
      'https://purescience.work/download/models/structure-recognition-primary.zip',
      `https://gh-proxy.com/https://github.com/naiyixi/PureScience/releases/download/models-v1/structure-recognition-primary.zip`,
      `https://ghfast.top/https://github.com/naiyixi/PureScience/releases/download/models-v1/structure-recognition-primary.zip`
    ])
    // A different asset revision has no twin over there, so nothing is guessed.
    expect(
      mirrorCandidatesFor(
        'https://github.com/naiyixi/PureScience/releases/download/models-v2/structure-recognition-primary.zip'
      ).map((candidate) => candidate.host)
    ).toEqual(['gh-proxy.com', 'ghfast.top'])
  })

  it('does not invent a self-host path for a runtime URL it cannot mirror exactly', () => {
    // Nested paths and query strings have no twin on our host; a guessed URL would 404 and read as an
    // outage, and a query string could be carrying a token.
    expect(
      mirrorCandidatesFor(
        'https://github.com/naiyixi/PureScience/releases/download/runtime-v1/nested/x.tar.zst'
      ).map((candidate) => candidate.host)
    ).toEqual(['gh-proxy.com', 'ghfast.top'])
    expect(
      mirrorCandidatesFor(
        'https://github.com/naiyixi/PureScience/releases/download/runtime-v1/x.tar.zst?token=secret'
      )
    ).toEqual([])
  })

  it('offers nothing for a GitHub URL that is not a release asset', () => {
    // A repo page, a clone URL or an API call has no published digest to check the bytes against, and a
    // release *page* would hand back HTML — "same host, same shape" proves nothing about content.
    expect(mirrorCandidatesFor('https://github.com/naiyixi/PureScience')).toEqual([])
    expect(
      mirrorCandidatesFor('https://github.com/naiyixi/PureScience/releases/tag/v2.5.1')
    ).toEqual([])
    expect(mirrorCandidatesFor('https://api.github.com/repos/naiyixi/PureScience')).toEqual([])
  })

  it('refuses a release asset URL that carries a query or credentials', () => {
    expect(mirrorCandidatesFor(`${asset}?token=abc`)).toEqual([])
    expect(
      mirrorCandidatesFor(
        'https://user:secret@github.com/naiyixi/PureScience/releases/download/models-v1/f.zip'
      )
    ).toEqual([])
  })
})

describe('streamWithMirrorFallback', () => {
  const asset =
    'https://github.com/naiyixi/PureScience/releases/download/models-v1/structure-recognition-primary.zip'
  const digest = 'b'.repeat(64)

  it('streams from the origin and says so when the origin works', async () => {
    const stream = vi.fn(async () => undefined)
    const removeFile = vi.fn(async () => undefined)
    const result = await streamWithMirrorFallback(
      asset,
      '/tmp/weights.part',
      { expectedSha256: digest },
      { stream, removeFile }
    )
    expect(result).toEqual({ path: '/tmp/weights.part', via: 'origin' })
    expect(stream).toHaveBeenCalledTimes(1)
    expect(stream).toHaveBeenCalledWith(asset, '/tmp/weights.part')
    expect(removeFile).not.toHaveBeenCalled()
  })

  // With the weights published on our own host, the first fallback is that copy — which is the point of
  // publishing them: a reader in China should reach bytes we serve before a third party's proxy.
  it('drops the origin partial and streams our own copy when the origin fails', async () => {
    const calls: string[] = []
    const removeFile = vi.fn(async () => undefined)
    const stream = vi.fn(async (url: string) => {
      calls.push(url)
      if (calls.length === 1) throw new Error('connect ETIMEDOUT')
    })
    const result = await streamWithMirrorFallback(
      asset,
      '/tmp/weights.part',
      { expectedSha256: digest },
      { stream, removeFile }
    )
    expect(result.via).toBe('purescience.work')
    expect(calls).toEqual([
      'https://github.com/naiyixi/PureScience/releases/download/models-v1/structure-recognition-primary.zip',
      'https://purescience.work/download/models/structure-recognition-primary.zip'
    ])
    // The partial from the origin's byte stream must not be glued onto the mirror's.
    expect(removeFile).toHaveBeenCalledWith('/tmp/weights.part')
  })

  it('never tries a mirror without a digest, and reports the origin failure', async () => {
    const stream = vi.fn(async () => {
      throw new Error('origin down')
    })
    await expect(
      streamWithMirrorFallback(asset, '/tmp/weights.part', {}, { stream })
    ).rejects.toThrow('origin down')
    expect(stream).toHaveBeenCalledTimes(1)
  })

  it('walks the candidates in order and surfaces the last failure', async () => {
    const hosts: string[] = []
    const stream = vi.fn(async (url: string) => {
      hosts.push(new URL(url).hostname)
      throw new Error(`failed: ${new URL(url).hostname}`)
    })
    await expect(
      streamWithMirrorFallback(
        asset,
        '/tmp/weights.part',
        { expectedSha256: digest },
        { stream, removeFile: async () => undefined }
      )
    ).rejects.toThrow('failed: ghfast.top')
    expect(hosts).toEqual(['github.com', 'purescience.work', 'gh-proxy.com', 'ghfast.top'])
  })
})
