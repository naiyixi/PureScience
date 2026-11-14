import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import {
  describeUpdateFailure,
  fetchManifest,
  parseManifest,
  UpdateManifestError
} from './manifest'

const valid = {
  version: '0.3.0',
  releaseDate: '2026-07-13',
  notes: 'n',
  downloads: {
    'mac-arm64': {
      url: 'https://github.com/naiyixi/PureScience/releases/download/v0.3.0/PureScience-0.3.0-arm64.dmg',
      size: 1,
      sha256: 'h'
    }
  }
}

describe('parseManifest', () => {
  it('accepts a well-formed manifest', () => {
    expect(parseManifest(valid).version).toBe('0.3.0')
  })
  it('defaults missing releaseDate/notes to empty strings', () => {
    const m = parseManifest({ version: '1.0.0', downloads: {} })
    expect(m.releaseDate).toBe('')
    expect(m.notes).toBe('')
  })
  it('throws on missing version', () => {
    expect(() => parseManifest({ downloads: {} })).toThrow()
  })
  it('throws on a malformed download entry', () => {
    expect(() => parseManifest({ version: '1.0.0', downloads: { x: { url: 1 } } })).toThrow()
  })
  it('rejects download URLs from hosts outside the allowlist', () => {
    expect(() =>
      parseManifest({
        version: '1.0.0',
        downloads: { x: { url: 'https://evil.example.com/a.dmg', size: 1, sha256: 'h' } }
      })
    ).toThrow()
  })
  it('rejects non-https download URLs', () => {
    expect(() =>
      parseManifest({
        version: '1.0.0',
        downloads: {
          x: { url: 'http://github.com/a.dmg', size: 1, sha256: 'h' }
        }
      })
    ).toThrow()
  })
  it('accepts githubusercontent release-asset hosts', () => {
    const m = parseManifest({
      version: '1.0.0',
      downloads: {
        x: {
          url: 'https://release-assets.githubusercontent.com/a.zip',
          size: 1,
          sha256: 'h'
        }
      }
    })
    expect(m.downloads.x.url).toContain('githubusercontent')
  })
})

describe('fetchManifest', () => {
  it('fetches and parses', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(valid) })
    const m = await fetchManifest('https://cdn/version.json', fetchImpl as unknown as typeof fetch)
    expect(m.version).toBe('0.3.0')
    expect(fetchImpl).toHaveBeenCalledWith('https://cdn/version.json', expect.any(Object))
  })
  it('throws on a non-ok response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 500 })
    await expect(
      fetchManifest('https://cdn/version.json', fetchImpl as unknown as typeof fetch)
    ).rejects.toThrow()
  })
})

// Why each of these exists: every one of them used to reach the log as `errorCategory: 'error'`, so a
// broken feed, an allowlist that no longer matches where assets are published, and a network that dropped
// mid-request were one and the same reading. The cause vocabulary is closed, so each class is pinned here.
describe('update failure attribution', () => {
  const causeOf = (error: unknown): string => describeUpdateFailure(error).failureCause

  it('names a non-2xx answer with its status', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 403 })
    const error = await fetchManifest(
      'https://cdn/version.json',
      fetchImpl as unknown as typeof fetch
    ).catch((thrown: unknown) => thrown)
    expect(describeUpdateFailure(error)).toEqual({ failureCause: 'http-status', httpStatus: 403 })
  })

  it('names a request that never got a response as transport, keeping the deadline distinct', async () => {
    const netDown = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    const transport = await fetchManifest(
      'https://cdn/version.json',
      netDown as unknown as typeof fetch
    ).catch((thrown: unknown) => thrown)
    expect(causeOf(transport)).toBe('transport')

    const timedOut = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('signal timed out'), { name: 'AbortError' }))
    const deadline = await fetchManifest(
      'https://cdn/version.json',
      timedOut as unknown as typeof fetch
    ).catch((thrown: unknown) => thrown)
    expect(causeOf(deadline)).toBe('deadline')
  })

  it('separates a payload that is not JSON from a shape error and an untrusted download host', async () => {
    const notJson = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.reject(new SyntaxError('x'))
    })
    const payload = await fetchManifest(
      'https://cdn/version.json',
      notJson as unknown as typeof fetch
    ).catch((thrown: unknown) => thrown)
    expect(describeUpdateFailure(payload)).toEqual({
      failureCause: 'invalid-manifest',
      manifestProblem: 'shape'
    })

    const shape = new UpdateManifestError('invalid-manifest', 'x', { manifestProblem: 'shape' })
    expect(describeUpdateFailure(shape).manifestProblem).toBe('shape')

    const host = (): unknown => {
      try {
        parseManifest({
          version: '1.0.0',
          downloads: { x: { url: 'https://evil.example.com/a.dmg', size: 1, sha256: 'h' } }
        })
      } catch (error) {
        return error
      }
      return undefined
    }
    expect(describeUpdateFailure(host())).toEqual({
      failureCause: 'invalid-manifest',
      manifestProblem: 'download-host'
    })

    const entry = (): unknown => {
      try {
        parseManifest({ version: '1.0.0', downloads: { x: { url: 1 } } })
      } catch (error) {
        return error
      }
      return undefined
    }
    expect(describeUpdateFailure(entry()).manifestProblem).toBe('download-entry')
  })

  it('says unclassified rather than guessing for an error it does not own', () => {
    expect(describeUpdateFailure(new Error('something else'))).toEqual({
      failureCause: 'unclassified'
    })
    expect(describeUpdateFailure(undefined)).toEqual({ failureCause: 'unclassified' })
  })

  // The vocabulary only stays usable if every construction site names a member of it: one `throw new Error(…)`
  // on this path and the line reads `failureCause: unclassified` for a case the code actually understands,
  // which is the same dead end this field was added to remove.
  it('keeps every update-path throw on the closed vocabulary', () => {
    const projectRoot = resolve(__dirname, '../../..')
    const causeUnion = /export type UpdateCheckFailureCause =([\s\S]*?)\n\n/.exec(
      readFileSync(resolve(projectRoot, 'src/main/update/manifest.ts'), 'utf8')
    )?.[1]
    const declared = [...(causeUnion ?? '').matchAll(/'([a-z-]+)'/g)].map((match) => match[1])
    expect(declared).toEqual([
      'http-status',
      'invalid-manifest',
      'transport',
      'deadline',
      'unclassified'
    ])

    for (const file of ['manifest.ts', 'service.ts']) {
      const source = readFileSync(resolve(projectRoot, 'src/main/update', file), 'utf8')
      const used = [...source.matchAll(/new UpdateManifestError\(\s*'([a-z-]+)'/g)].map(
        (match) => match[1]
      )
      expect(used.length).toBeGreaterThan(0)
      for (const cause of used) expect(declared).toContain(cause)
      // A bare `throw new Error(` would bypass the vocabulary entirely.
      expect(source).not.toMatch(/throw new Error\(/)
    }
  })
})
