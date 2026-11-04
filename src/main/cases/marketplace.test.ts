import { mkdtemp, readFile, readdir, rm, stat, writeFile, mkdir } from 'node:fs/promises'
import { Blob as NodeBlob } from 'node:buffer'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import * as tar from 'tar'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CASE_MARKETPLACE_FORMAT, CASE_MARKETPLACE_VERSION } from '../../shared/case-marketplace'
import { exportCaseBundle } from './export-bundle'
import {
  downloadCaseArchive,
  fetchCaseMarketplaceIndex,
  installCaseFromMarketplace,
  packCaseArchive,
  unpackCaseArchive,
  type CaseMarketplaceFetch
} from './marketplace'

let scratch: string

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'ps-market-test-'))
})

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true })
})

const responseOf = (
  bytes: Uint8Array,
  contentType = 'application/gzip'
): ReturnType<CaseMarketplaceFetch> =>
  Promise.resolve({
    ok: true,
    status: 200,
    headers: {
      get: (name: string) => (name === 'content-length' ? String(bytes.byteLength) : contentType)
    },
    body: new NodeBlob([
      bytes as unknown as ArrayBuffer
    ]).stream() as unknown as ReadableStream<Uint8Array>,
    json: async () => JSON.parse(Buffer.from(bytes).toString('utf8'))
  })

const serveFile = async (path: string): Promise<CaseMarketplaceFetch> => {
  const bytes = await readFile(path)
  return () => responseOf(bytes)
}

/** Builds a real bundle with the real exporter, then the real archive. Nothing here is a fixture. */
const buildBundle = async (): Promise<{
  bundleDir: string
  archiveFile: string
  sha256: string
}> => {
  const sources = join(scratch, 'sources')
  await mkdir(sources, { recursive: true })
  await writeFile(join(sources, 'report.md'), '# 结果\nHEMOGLOBIN 12.4 g/dL\n')
  await writeFile(join(sources, 'table.csv'), 'gene,score\nEGFR,0.91\n')

  const exported = await exportCaseBundle({
    caseName: 'GPCR 激活途径',
    domain: 'structure',
    destinationDir: join(scratch, 'out'),
    files: [
      { name: 'report.md', sourcePath: join(sources, 'report.md') },
      { name: 'table.csv', sourcePath: join(sources, 'table.csv') }
    ]
  })
  if (!exported.ok) throw new Error(`export refused: ${exported.problem}`)

  const archiveFile = join(scratch, 'case.tar.gz')
  const packed = await packCaseArchive(exported.bundleDir, archiveFile)
  if (!packed.ok) throw new Error(`pack refused: ${packed.problem}`)
  return { bundleDir: exported.bundleDir, archiveFile, sha256: packed.sha256 }
}

const entryFor = (
  archive: { archiveFile: string; sha256: string },
  overrides: Record<string, unknown> = {}
): Record<string, unknown> => ({
  id: 'gpcr-activation',
  name: 'GPCR 激活途径',
  domain: 'structure',
  summary: '采样收敛与滞后审计',
  author: 'Able',
  license: 'MIT',
  bundleUrl: 'https://example.test/gpcr.tar.gz',
  bundleSha256: archive.sha256,
  fileCount: 2,
  totalBytes: 44,
  publishedAt: 1_760_000_000_000,
  ...overrides
})

describe('reading the index', () => {
  const good = {
    format: CASE_MARKETPLACE_FORMAT,
    version: CASE_MARKETPLACE_VERSION,
    updatedAt: 1,
    cases: [
      {
        id: 'a',
        name: 'A',
        domain: 'general',
        summary: 's',
        author: 'x',
        license: 'MIT',
        bundleUrl: 'https://example.test/a.tar.gz',
        bundleSha256: 'b'.repeat(64),
        fileCount: 1,
        totalBytes: 1,
        publishedAt: 1
      }
    ]
  }

  it('accepts a real release document served over the network layer', async () => {
    const fetchImpl: CaseMarketplaceFetch = () =>
      Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: () => null },
        body: new NodeBlob([
          JSON.stringify(good)
        ]).stream() as unknown as ReadableStream<Uint8Array>,
        json: async () => good
      })
    const result = await fetchCaseMarketplaceIndex('https://example.test/index.json', { fetchImpl })
    expect(result.ok).toBe(true)
  })

  it('stops a document that claims to be bigger than an index can be', async () => {
    const fetchImpl: CaseMarketplaceFetch = () =>
      Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: (name: string) => (name === 'content-length' ? '99999999' : null) },
        body: null,
        json: async () => good
      })
    expect(
      await fetchCaseMarketplaceIndex('https://example.test/i.json', { fetchImpl })
    ).toMatchObject({
      problem: 'too-large'
    })
  })

  it('says why a document is not an index instead of "failed"', async () => {
    const fetchImpl: CaseMarketplaceFetch = () =>
      Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: () => null },
        body: new Blob([
          '{"format":"something-else"}'
        ]).stream() as unknown as ReadableStream<Uint8Array>,
        json: async () => ({ format: 'something-else' })
      })
    expect(
      await fetchCaseMarketplaceIndex('https://example.test/i.json', { fetchImpl })
    ).toMatchObject({
      problem: 'bad-index',
      detail: 'unknown-format'
    })
  })

  it('reports an unreachable host and an HTTP error separately', async () => {
    const down: CaseMarketplaceFetch = () => Promise.reject(new Error('getaddrinfo ENOTFOUND'))
    expect(
      await fetchCaseMarketplaceIndex('https://nowhere.test/i.json', { fetchImpl: down })
    ).toMatchObject({ problem: 'unreachable' })
    const notFound: CaseMarketplaceFetch = () =>
      Promise.resolve({
        ok: false,
        status: 404,
        headers: { get: () => null },
        body: null,
        json: async () => null
      })
    expect(
      await fetchCaseMarketplaceIndex('https://example.test/i.json', { fetchImpl: notFound })
    ).toMatchObject({ problem: 'bad-response', detail: 'HTTP 404' })
  })
})

describe('packing a case archive', () => {
  it('carries the bundle directory name, never the absolute path it happened to live at', async () => {
    const archive = await buildBundle()
    const entries: string[] = []
    await tar.t({
      file: archive.archiveFile,
      onReadEntry: (entry): void => {
        entries.push(entry.path)
      }
    })
    expect(entries.length).toBeGreaterThan(0)
    // The reader looks for exactly one directory in the archive and reads the manifest inside it. Packing has to
    // name that directory the way the destination filesystem spells it — a Windows bundle directory is
    // `C:\…\out\<name>`, and any splitting on a forward slash leaves it whole, so every entry gets buried under
    // `Users/…` and the install then refuses a bundle this code packed itself (measured on the Windows lane).
    const tops = new Set(entries.map((path) => path.split('/')[0]))
    expect([...tops]).toEqual([basename(archive.bundleDir)])
    for (const path of entries) {
      expect(path).not.toMatch(/^[A-Za-z]:/)
      expect(path.startsWith('/') || path.startsWith('\\')).toBe(false)
      expect(path).not.toContain('\\')
    }
  })
})

describe('installing a case', () => {
  it('downloads, checks the digest, unpacks, re-verifies every file and copies it in', async () => {
    const archive = await buildBundle()
    const targetDir = join(scratch, 'library')
    const result = await installCaseFromMarketplace(entryFor(archive) as never, {
      targetDir,
      fetchImpl: await serveFile(archive.archiveFile),
      scratchRoot: scratch
    })
    expect(result).toMatchObject({ ok: true, name: 'GPCR 激活途径', fileCount: 2 })
    if (!result.ok) return
    // The bytes that landed are the bytes that were packed.
    expect(await readFile(join(result.installedTo, 'report.md'), 'utf8')).toBe(
      '# 结果\nHEMOGLOBIN 12.4 g/dL\n'
    )
    expect(await readFile(join(result.installedTo, 'table.csv'), 'utf8')).toBe(
      'gene,score\nEGFR,0.91\n'
    )
  })

  it('stops at the digest — a tampered archive never reaches the unpacker', async () => {
    const archive = await buildBundle()
    const targetDir = join(scratch, 'library-refused')
    const result = await installCaseFromMarketplace(
      entryFor(archive, { bundleSha256: 'c'.repeat(64) }) as never,
      { targetDir, fetchImpl: await serveFile(archive.archiveFile), scratchRoot: scratch }
    )
    expect(result).toMatchObject({ ok: false, problem: 'checksum-mismatch' })
    // Nothing was created, not even the library directory.
    await expect(stat(targetDir)).rejects.toThrow()
  })

  it('refuses an archive bigger than a case can be, before writing it out', async () => {
    const archive = await buildBundle()
    const result = await downloadCaseArchive(
      archive.archiveFile.startsWith('/') ? 'https://example.test/a' : '',
      join(scratch, 'big.tar.gz'),
      {
        fetchImpl: await serveFile(archive.archiveFile),
        maxBytes: 16
      }
    )
    expect(result).toMatchObject({ ok: false, problem: 'too-large' })
    await expect(stat(join(scratch, 'big.tar.gz'))).rejects.toThrow()
  })

  it('gives up on an archive that stops arriving, instead of waiting forever', async () => {
    // A body that yields one chunk and then stalls is what a dropped connection looks like.
    const stalled: CaseMarketplaceFetch = () =>
      Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: () => null },
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2, 3]))
            // never closes
          }
        }) as unknown as ReadableStream<Uint8Array>,
        json: async () => null
      })
    const result = await downloadCaseArchive(
      'https://example.test/stall',
      join(scratch, 'stall.tar.gz'),
      {
        fetchImpl: stalled,
        idleTimeoutMs: 120
      }
    )
    expect(result).toMatchObject({ ok: false, problem: 'unreachable', detail: 'timed-out' })
    await expect(stat(join(scratch, 'stall.tar.gz'))).rejects.toThrow()
  })

  it('names an archive entry that tries to leave the staging directory', async () => {
    const evilRoot = join(scratch, 'evil-src')
    await mkdir(evilRoot, { recursive: true })
    await writeFile(join(evilRoot, 'escape.txt'), 'x')
    const evilArchive = join(scratch, 'evil.tar.gz')
    await tar.c({ gzip: true, file: evilArchive, cwd: evilRoot }, ['../evil-src/escape.txt'])

    const unpacked = await unpackCaseArchive(evilArchive, join(scratch, 'evil-out'))
    // Either the entry is refused by name, or tar itself declines; what must never happen is a file outside.
    expect(unpacked.ok).toBe(false)
    await expect(stat(join(scratch, 'escape.txt'))).rejects.toThrow()
  })

  it('refuses a bundle whose files disagree with its manifest, even when the archive digest matched', async () => {
    const archive = await buildBundle()
    // Rewrite the archive with one file's content changed, then pin the *new* archive digest: the transport is now
    // trustworthy by construction, and the bundle reader still has to catch the file.
    const brokenDir = join(scratch, 'broken-package')
    await mkdir(brokenDir, { recursive: true })
    await tar.x({ file: archive.archiveFile, cwd: brokenDir })
    const inner = (await readdir(brokenDir))[0]
    await writeFile(join(brokenDir, inner, 'files', 'report.md'), 'tampered\n')
    const repacked = join(scratch, 'broken.tar.gz')
    await tar.c({ gzip: true, file: repacked, cwd: brokenDir }, [inner])
    const packedDigest = await import('./marketplace').then((module) =>
      module.packCaseArchive(join(brokenDir, inner), repacked)
    )

    const result = await installCaseFromMarketplace(
      entryFor({
        archiveFile: repacked,
        sha256: packedDigest.ok ? packedDigest.sha256 : ''
      }) as never,
      {
        targetDir: join(scratch, 'library-broken'),
        fetchImpl: await serveFile(repacked),
        scratchRoot: scratch
      }
    )
    expect(result).toMatchObject({ ok: false, problem: 'incomplete' })
    if (result.ok) return
    expect(result.problematic?.checksumMismatch).toEqual(['report.md'])
  })
})
