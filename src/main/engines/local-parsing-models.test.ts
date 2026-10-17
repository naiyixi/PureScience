import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { downloadLocalParsingModel, readLocalParsingModels } from './local-parsing-models'
import { modelWeightPath, sha256Of } from './model-weight-cache'

// A manifest on disk, an entry whose bytes we control, and the two facts the settings section needs:
// what this build ships, and whether a file of the published size is already cached.

const weights = new TextEncoder().encode('pretend local parsing model weights')
const digest = sha256Of(weights)

const entry = {
  id: 'structure-recognition-primary',
  revision: 'zenodo-10.5281/zenodo.8300489',
  publisher: 'the authors, via the record',
  url: 'https://example.invalid/models.zip',
  sha256: digest,
  bytes: weights.byteLength,
  license: 'CC-BY-4.0',
  kind: 'structure-recognition' as const,
  publisherMd5: 'de78c966b0d63b290cd3f70bb81a91e7',
  note: 'test entry'
}

const writeManifest = async (
  dir: string,
  entries: unknown[],
  overrides: Record<string, unknown> = {}
): Promise<string> => {
  const path = join(dir, 'manifest.json')
  await writeFile(
    path,
    `${JSON.stringify({ schema: 1, revision: 'test.1', entries, ...overrides }, null, 2)}\n`
  )
  return path
}

describe('readLocalParsingModels', () => {
  it('reports an absent manifest as absent, not as "no models"', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lpm-'))
    const view = await readLocalParsingModels({
      cacheDir: dir,
      override: join(dir, 'not-here.json'),
      fromDir: dir
    })
    expect(view.report.state).toBe('absent')
    expect(view.report.present).toBe(false)
    // entryCount stays absent rather than becoming 0: nobody counted anything.
    expect(view.report.entryCount).toBeUndefined()
    expect(view.models).toHaveLength(0)
  })

  it('reports an invalid manifest with its reason and problems, and lists nothing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lpm-'))
    await writeManifest(dir, [{ ...entry, sha256: 'NOT-A-DIGEST' }])
    const view = await readLocalParsingModels({
      cacheDir: dir,
      override: join(dir, 'manifest.json'),
      fromDir: dir
    })
    expect(view.report.state).toBe('invalid')
    expect(view.report.reason).toBe('failed-validation')
    expect(view.report.problems.map((problem) => problem.field)).toContain('sha256')
    expect(view.models).toHaveLength(0)
  })

  it('gives the renderer no url and no path — only what a settings panel shows', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lpm-'))
    await writeManifest(dir, [entry])
    const view = await readLocalParsingModels({
      cacheDir: dir,
      override: join(dir, 'manifest.json'),
      fromDir: dir
    })
    expect(view.report.state).toBe('usable')
    expect(view.models).toHaveLength(1)
    // Exact keys, not "does not contain": a field added later has to be a deliberate decision here.
    expect(Object.keys(view.models[0]).sort()).toEqual(
      [
        'bytes',
        'id',
        'installed',
        'kind',
        'license',
        'publisher',
        'publisherMd5',
        'revision',
        'sha256'
      ].sort()
    )
    expect(JSON.stringify(view)).not.toContain('example.invalid')
    expect(JSON.stringify(view)).not.toContain(dir)
  })

  it('calls a model installed only when a file of exactly the published size is cached', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lpm-'))
    await writeManifest(dir, [entry])
    const read = (): ReturnType<typeof readLocalParsingModels> =>
      readLocalParsingModels({ cacheDir: dir, override: join(dir, 'manifest.json'), fromDir: dir })

    expect((await read()).models[0].installed).toBe(false)

    const path = modelWeightPath(dir, entry.id)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, weights.subarray(0, 4))
    expect((await read()).models[0].installed).toBe(false)

    await writeFile(path, weights)
    expect((await read()).models[0].installed).toBe(true)
    // The restored run of the same question: presence by size, and the digest is checked when it matters.
    expect((await stat(path)).size).toBe(entry.bytes)
  })
})

describe('downloadLocalParsingModel', () => {
  const streamerFor =
    (bytes: Uint8Array) =>
    async (_url: string, dest: string): Promise<void> => {
      await writeFile(dest, bytes)
    }

  it('refuses an entry whose digest is not a published sha256, and fetches nothing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lpm-'))
    await writeManifest(dir, [{ ...entry, sha256: 'nope' }])
    let called = 0
    const view = await downloadLocalParsingModel({
      id: entry.id,
      consent: true,
      cacheDir: dir,
      override: join(dir, 'manifest.json'),
      fromDir: dir,
      streamWeights: async (url, dest) => {
        called += 1
        await streamerFor(weights)(url, dest)
      }
    })
    expect(view.status).toBe('unresolved')
    expect(called).toBe(0)
  })

  it('refuses without consent even when everything else is in order', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lpm-'))
    await writeManifest(dir, [entry])
    let called = 0
    const view = await downloadLocalParsingModel({
      id: entry.id,
      consent: false,
      cacheDir: dir,
      override: join(dir, 'manifest.json'),
      fromDir: dir,
      streamWeights: async (url, dest) => {
        called += 1
        await streamerFor(weights)(url, dest)
      }
    })
    expect(view.status).toBe('needs-consent')
    expect(called).toBe(0)
  })

  it('downloads, verifies, and reports the digest of the file that was verified', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lpm-'))
    await writeManifest(dir, [entry])
    const view = await downloadLocalParsingModel({
      id: entry.id,
      consent: true,
      cacheDir: dir,
      override: join(dir, 'manifest.json'),
      fromDir: dir,
      streamWeights: streamerFor(weights)
    })
    expect(view.status).toBe('downloaded')
    expect(view.verifiedSha256).toBe(digest)
    expect(view.message.length).toBeGreaterThan(0)
    expect((await stat(modelWeightPath(dir, entry.id))).size).toBe(entry.bytes)

    const again = await downloadLocalParsingModel({
      id: entry.id,
      consent: true,
      cacheDir: dir,
      override: join(dir, 'manifest.json'),
      fromDir: dir,
      streamWeights: async () => {
        throw new Error('must not fetch again')
      }
    })
    expect(again.status).toBe('cached')
    await rm(dir, { recursive: true, force: true })
  })

  it('names the mirror in the sentence the reader sees when the bytes came from one', async () => {
    // The fallback is only honest if the reader can tell: "downloaded" with no host would make a mirrored
    // file look like one that came from the published location.
    const dir = await mkdtemp(join(tmpdir(), 'lpm-'))
    await writeManifest(dir, [entry])
    const view = await downloadLocalParsingModel({
      id: entry.id,
      consent: true,
      cacheDir: dir,
      override: join(dir, 'manifest.json'),
      fromDir: dir,
      streamWeights: async (url, dest) => {
        await streamerFor(weights)(url, dest)
        return 'gh-proxy.com'
      }
    })
    expect(view.status).toBe('downloaded')
    expect(view.message).toContain('经镜像 gh-proxy.com')
    await rm(dir, { recursive: true, force: true })
  })

  it('refuses an id that is not in the shipped manifest', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lpm-'))
    await writeManifest(dir, [entry])
    const view = await downloadLocalParsingModel({
      id: 'not-shipped',
      consent: true,
      cacheDir: dir,
      override: join(dir, 'manifest.json'),
      fromDir: dir,
      streamWeights: streamerFor(weights)
    })
    expect(view.status).toBe('unresolved')
  })
})
