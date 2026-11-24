import { mkdtempSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { manifestUrl, packUrl } from '../src/main/notebook/bundle-manifest'
import { VERSIONS, packArchiveFile, packId } from './stage-default-envs.mjs'
import {
  packCachePath,
  prewarmRuntimePack,
  runtimeManifestUrl,
  runtimePackUrl,
  validatePublishedManifest,
  verifyRuntimeBundle
} from './verify-runtime-bundle.mjs'

// `scripts/*.mjs` is outside both tsconfig projects, so its exports arrive here untyped (`allowJs` is off;
// turning it on was measured at 65 pre-existing errors, mostly vitest-mock variance). Pin the shape the
// module documents once, so the fixture below is checked instead of silently drifting in as `unknown`.
const VERSIONS_BY_LANGUAGE = VERSIONS as Record<string, readonly string[]>

const manifest = (subdir = 'osx-arm64', envVersion = 1): Record<string, unknown> => ({
  schema: 1,
  envVersion,
  subdir,
  packs: Object.fromEntries(
    Object.entries(VERSIONS_BY_LANGUAGE).flatMap(([language, versions]) =>
      versions.map((version) => [
        packId(language, version),
        {
          language,
          version,
          file: packArchiveFile(language, version),
          sha256: 'a'.repeat(64),
          size: 42
        }
      ])
    )
  )
})

describe('runtime bundle release preflight', () => {
  it('builds the same immutable CDN path as the runtime client', () => {
    expect(runtimeManifestUrl('https://cdn.example/root/', 3, 'win-64')).toBe(
      'https://cdn.example/root/runtime-bundle/3/win-64/manifest.json'
    )
  })

  it('accepts a complete canonical manifest', () => {
    expect(() => validatePublishedManifest(manifest(), 1, 'osx-arm64')).not.toThrow()
  })

  it('rejects the wrong platform and missing curated packs', () => {
    expect(() => validatePublishedManifest(manifest('linux-64'), 1, 'osx-arm64')).toThrow(/subdir/)
    const incomplete = manifest() as { packs: Record<string, unknown> }
    delete incomplete.packs['python-3.12']
    expect(() => validatePublishedManifest(incomplete, 1, 'osx-arm64')).toThrow(
      /missing python-3.12/
    )
  })

  it('fails closed on an unavailable manifest', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 404 }))
    await expect(
      verifyRuntimeBundle('https://cdn.example', 1, ['linux-64'], fetchImpl)
    ).rejects.toThrow(/HTTP 404/)
  })
})

// The prewarm step feeds the runtime client's machine cache (PURESCIENCE_RUNTIME_PACK_CACHE). Two facts
// have to stay true or the step becomes worse than useless: it must write exactly the layout the client
// reads, and it must refuse bytes the manifest digest does not name.
describe('runtime pack prewarm', () => {
  const makeCache = (): string => mkdtempSync(join(tmpdir(), 'pack-prewarm-'))

  const shaFor =
    (m: Record<string, unknown>) =>
    async (path: string): Promise<string> => {
      const packs = m.packs as Record<string, { file: string; sha256: string }>
      // Downloads land under a `.part` name first — the digest is taken there before the rename, so the
      // fixture has to look at the archive name rather than the staging name.
      const file = basename(path).replace(/\.part$/, '')
      const entry = Object.values(packs).find(({ file: name }) => name === file)
      return entry?.sha256 ?? 'f'.repeat(64)
    }

  const fetchFor =
    (m: Record<string, unknown>, seen: string[] = []) =>
    async (url: string): Promise<Response> => {
      seen.push(url)
      if (url.endsWith('-manifest.json')) return new Response(JSON.stringify(m), { status: 200 })
      return new Response(Buffer.alloc(42), { status: 200 })
    }

  it('composes the same pack URL as the runtime client', () => {
    for (const base of [
      'https://cdn.example/root',
      'https://github.com/o/r/releases/download/rt-v1'
    ]) {
      expect(runtimePackUrl(base, 2, 'win-64', 'python-3.12.tar.zst')).toBe(
        packUrl(base, 2, 'win-64', 'python-3.12.tar.zst')
      )
      expect(runtimeManifestUrl(base, 2, 'win-64')).toBe(manifestUrl(base, 2, 'win-64'))
    }
    // ...and the cache layout the client reads: <cache>/<subdir>/<envVersion>/<file>.
    expect(packCachePath('/cache', 'win-64', 2, 'python-3.12.tar.zst')).toBe(
      join('/cache', 'win-64', '2', 'python-3.12.tar.zst')
    )
  })

  it('fetches each curated python pack into the cache, then reuses it without another transfer', async () => {
    const m = manifest('win-64')
    const cacheDir = makeCache()
    const seen: string[] = []

    const first = await prewarmRuntimePack({
      cacheDir,
      cdnBase: 'https://github.com/o/r/releases/download/rt-v1',
      envVersion: 1,
      subdir: 'win-64',
      fetchImpl: fetchFor(m, seen),
      sha256: shaFor(m),
      log: () => undefined
    })
    expect(first.every(({ action }) => action === 'fetched')).toBe(true)
    for (const entry of Object.values(
      (m as { packs: Record<string, { file: string; language: string }> }).packs
    )) {
      // Only the requested language is warmed: the R pack is ~345 MB and no P0 journey needs it.
      expect(existsSync(join(cacheDir, 'win-64', '1', entry.file))).toBe(
        entry.language === 'python'
      )
    }

    const packsBefore = seen.filter((url) => !url.endsWith('-manifest.json')).length
    const second = await prewarmRuntimePack({
      cacheDir,
      cdnBase: 'https://github.com/o/r/releases/download/rt-v1',
      envVersion: 1,
      subdir: 'win-64',
      fetchImpl: fetchFor(m, seen),
      sha256: shaFor(m),
      log: () => undefined
    })
    expect(second.every(({ action }) => action === 'have')).toBe(true)
    // A warm cache costs one manifest request, not one transfer per pack.
    expect(seen.filter((url) => !url.endsWith('-manifest.json')).length).toBe(packsBefore)
  })

  it('refuses a transfer whose digest disagrees, leaving no half-written archive behind', async () => {
    const m = manifest('win-64')
    const cacheDir = makeCache()
    await expect(
      prewarmRuntimePack({
        cacheDir,
        cdnBase: 'https://github.com/o/r/releases/download/rt-v1',
        envVersion: 1,
        subdir: 'win-64',
        fetchImpl: fetchFor(m),
        sha256: async () => 'f'.repeat(64),
        log: () => undefined,
        maxAttempts: 1
      })
    ).rejects.toThrow(/could not prewarm/)
    const cacheRoot = join(cacheDir, 'win-64', '1')
    const leftovers = existsSync(cacheRoot) ? readdirSync(cacheRoot) : []
    expect(leftovers.filter((name) => name.endsWith('.part'))).toEqual([])
  })
})
