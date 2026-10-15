import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { validateModelWeightManifest } from '../src/main/engines/model-weight-manifest'
import {
  buildManifest,
  createUploadAsset,
  publish,
  realDeps,
  verifyManifestAgainstDirectory
} from './publish-model-weights.mjs'

// Fixtures are real files on a real filesystem: computing the digest is the entire job, so a stubbed
// hasher would prove nothing about it. The repository's recipe (sha256 over the bytes, lowercase hex)
// is written out here by hand rather than taken from the module under test, so a shared mistake cannot
// make both sides agree.
const digestOf = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

const roots: string[] = []
const makeRoot = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'ps-model-weights-'))
  roots.push(dir)
  return dir
}
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true })
})

const DOC_BYTES = Buffer.from('document-parse weights, revision one\n')
const OCSR_BYTES = Buffer.from('structure-recognition weights, revision one and a little more\n')

const writeSpec = (dir: string, overrides: Partial<Record<string, unknown>> = {}): string => {
  const spec = {
    releaseBase: 'https://github.com/naiyixi/PureScience/releases/download/models-v1',
    manifestRevision: '2026-10-16.1',
    publisher: 'PureScience',
    entries: [
      {
        id: 'doc-parse-primary',
        revision: 'abc123',
        kind: 'document-parse',
        license: 'Apache-2.0',
        file: 'doc-parse.onnx',
        note: 'layout + text, offline'
      },
      {
        id: 'ocsr-primary',
        revision: 'def456',
        kind: 'structure-recognition',
        license: 'MIT',
        file: 'ocsr.onnx',
        assetName: 'ocsr-v2.onnx'
      }
    ],
    ...overrides
  }
  const specPath = join(dir, 'spec.json')
  writeFileSync(specPath, `${JSON.stringify(spec, null, 2)}\n`)
  return specPath
}

const makeWeightsDir = (): string => {
  const dir = makeRoot()
  writeFileSync(join(dir, 'doc-parse.onnx'), DOC_BYTES)
  writeFileSync(join(dir, 'ocsr.onnx'), OCSR_BYTES)
  return dir
}

// The directory a released revision would actually hold: assets named as published. One entry renames
// its file (`ocsr.onnx` -> `ocsr-v2.onnx`), which is why the staging dir above is not this one.
const makeAssetsDir = (): string => {
  const dir = makeRoot()
  writeFileSync(join(dir, 'doc-parse.onnx'), DOC_BYTES)
  writeFileSync(join(dir, 'ocsr-v2.onnx'), OCSR_BYTES)
  return dir
}

// Everything except the two network halves is the real implementation; those two are injected so the
// offline path can be proven not to reach them and the upload path can be driven without a release.
const depsWith = (overrides: Record<string, unknown> = {}): typeof realDeps =>
  ({ ...realDeps, ...overrides }) as typeof realDeps

describe('buildManifest', () => {
  it('digests the real bytes it is about to host, and stamps us as the publisher', async () => {
    const dir = makeWeightsDir()
    const { manifest, assets, repo, tag } = await buildManifest({ specPath: writeSpec(dir) })

    expect(manifest.schema).toBe(1)
    expect(manifest.revision).toBe('2026-10-16.1')
    expect(manifest.entries).toHaveLength(2)
    expect(manifest.entries[0]).toMatchObject({
      id: 'doc-parse-primary',
      revision: 'abc123',
      publisher: 'PureScience',
      kind: 'document-parse',
      license: 'Apache-2.0',
      url: 'https://github.com/naiyixi/PureScience/releases/download/models-v1/doc-parse.onnx',
      sha256: digestOf(DOC_BYTES),
      bytes: DOC_BYTES.length
    })
    // The second entry names its asset explicitly, and the URL follows that name rather than the file.
    expect(manifest.entries[1].url.endsWith('/ocsr-v2.onnx')).toBe(true)
    expect(manifest.entries[1].sha256).toBe(digestOf(OCSR_BYTES))

    expect(assets.map((asset) => asset.assetName)).toEqual(['doc-parse.onnx', 'ocsr-v2.onnx'])
    expect(repo).toBe('naiyixi/PureScience')
    expect(tag).toBe('models-v1')
  })

  it('produces a manifest the reader module accepts — publisher and reader agree on the shape', async () => {
    const dir = makeWeightsDir()
    const { manifest } = await buildManifest({ specPath: writeSpec(dir) })
    expect(validateModelWeightManifest(manifest)).toEqual([])
  })

  it('refuses a releaseBase that is not a GitHub release download URL', async () => {
    const dir = makeWeightsDir()
    const specPath = writeSpec(dir, {
      releaseBase: 'https://example.com/weights'
    })
    await expect(buildManifest({ specPath })).rejects.toMatchObject({
      reason: 'release-base-invalid'
    })
  })

  it('refuses a blank publisher instead of publishing "by nobody"', async () => {
    const dir = makeWeightsDir()
    await expect(
      buildManifest({ specPath: writeSpec(dir, { publisher: '   ' }) })
    ).rejects.toMatchObject({
      reason: 'publisher-missing'
    })
  })

  it('refuses an empty entry list — a publish run with nothing to publish is a mistake', async () => {
    const dir = makeWeightsDir()
    await expect(
      buildManifest({ specPath: writeSpec(dir, { entries: [] }) })
    ).rejects.toMatchObject({
      reason: 'entries-empty'
    })
  })

  it('refuses two entries claiming the same asset name', async () => {
    const dir = makeWeightsDir()
    const specPath = writeSpec(dir, {
      entries: [
        {
          id: 'a',
          revision: 'r1',
          kind: 'illustration',
          license: 'MIT',
          file: 'doc-parse.onnx',
          assetName: 'same.bin'
        },
        {
          id: 'b',
          revision: 'r2',
          kind: 'illustration',
          license: 'MIT',
          file: 'ocsr.onnx',
          assetName: 'same.bin'
        }
      ]
    })
    await expect(buildManifest({ specPath })).rejects.toMatchObject({
      reason: 'asset-name-duplicated'
    })
  })

  it('refuses a file that is not on disk, and an asset name that is a path', async () => {
    const dir = makeWeightsDir()
    await expect(
      buildManifest({
        specPath: writeSpec(dir, {
          entries: [
            { id: 'a', revision: 'r1', kind: 'illustration', license: 'MIT', file: 'absent.onnx' }
          ]
        })
      })
    ).rejects.toMatchObject({ reason: 'entry-file-missing' })

    await expect(
      buildManifest({
        specPath: writeSpec(dir, {
          entries: [
            {
              id: 'a',
              revision: 'r1',
              kind: 'illustration',
              license: 'MIT',
              file: 'ocsr.onnx',
              assetName: 'nested/ocsr.onnx'
            }
          ]
        })
      })
    ).rejects.toMatchObject({ reason: 'asset-name-invalid' })
  })

  it('refuses to publish zero bytes rather than hand out a digest for nothing', async () => {
    const dir = makeWeightsDir()
    writeFileSync(join(dir, 'empty.onnx'), Buffer.alloc(0))
    const specPath = writeSpec(dir, {
      entries: [
        { id: 'a', revision: 'r1', kind: 'illustration', license: 'MIT', file: 'empty.onnx' }
      ]
    })
    await expect(buildManifest({ specPath })).rejects.toMatchObject({ reason: 'entry-file-empty' })
  })

  it('fails on the reader rules it does not restate: a blank license is a refusal, not a warning', async () => {
    const dir = makeWeightsDir()
    const specPath = writeSpec(dir, {
      entries: [{ id: 'a', revision: 'r1', kind: 'illustration', license: '', file: 'ocsr.onnx' }]
    })
    await expect(buildManifest({ specPath })).rejects.toMatchObject({ reason: 'manifest-invalid' })
  })
})

describe('publish, offline', () => {
  it('writes the manifest without touching the network at all', async () => {
    const dir = makeWeightsDir()
    const outPath = join(dir, 'manifest.json')
    let uploadCalls = 0
    let fetchCalls = 0

    const result = await publish({
      specPath: writeSpec(dir),
      outPath,
      deps: depsWith({
        uploadAsset: () => {
          uploadCalls += 1
        },
        fetchAsset: () => {
          fetchCalls += 1
          throw new Error('offline mode must not fetch')
        }
      })
    })

    expect(uploadCalls).toBe(0)
    expect(fetchCalls).toBe(0)
    expect(result.uploaded).toBe(0)
    const written = JSON.parse(readFileSync(outPath, 'utf8'))
    expect(written.entries[0].sha256).toBe(digestOf(DOC_BYTES))
  })
})

describe('publish, upload', () => {
  it('uploads every asset, re-hashes what the URL actually serves, and only then writes', async () => {
    const dir = makeWeightsDir()
    const outPath = join(dir, 'manifest.json')
    const uploaded: string[] = []
    const served = new Map<string, Buffer>([
      ['doc-parse.onnx', DOC_BYTES],
      ['ocsr-v2.onnx', OCSR_BYTES]
    ])

    const result = await publish({
      specPath: writeSpec(dir),
      outPath,
      upload: true,
      deps: depsWith({
        // The uploader is asked for an asset by *name* — that name is what the manifest URL will point at,
        // so asserting on it is asserting the promise the reader will act on. (Deriving it here from the
        // local path with a hard-coded separator would have been a statement about the host instead: the
        // shipped file is `/`-separated on macOS and `\`-separated on Windows.)
        uploadAsset: ({ name, repo, tag }: { name: string; repo: string; tag: string }) => {
          uploaded.push(`${repo}@${tag}:${name}`)
        },
        fetchAsset: (url: string) => served.get(url.split('/').pop() as string) as Buffer
      })
    })

    expect(uploaded).toEqual([
      'naiyixi/PureScience@models-v1:doc-parse.onnx',
      'naiyixi/PureScience@models-v1:ocsr-v2.onnx'
    ])
    // And the two halves agree: every name we uploaded is a name the manifest publishes.
    const written = JSON.parse(readFileSync(outPath, 'utf8')) as { entries: { url: string }[] }
    expect(uploaded.map((call) => call.split(':').pop())).toEqual(
      written.entries.map((entry) => entry.url.split('/').pop())
    )
    expect(result.verified).toBe(2)
    expect(written.entries).toHaveLength(2)
  })

  it('refuses, names the asset, and writes nothing when the published bytes differ from the digest', async () => {
    const dir = makeWeightsDir()
    const outPath = join(dir, 'manifest.json')
    const tampered = Buffer.from(DOC_BYTES)
    tampered[0] = tampered[0] ^ 0xff

    const failure = publish({
      specPath: writeSpec(dir),
      outPath,
      upload: true,
      deps: depsWith({
        uploadAsset: () => undefined,
        // The first asset comes back changed: same length, different bytes.
        fetchAsset: (url: string) => (url.endsWith('doc-parse.onnx') ? tampered : OCSR_BYTES)
      })
    })

    await expect(failure).rejects.toMatchObject({ reason: 'published-bytes-mismatch' })
    await expect(failure).rejects.toThrow(/doc-parse\.onnx/)
    // "Nothing was verified" must not leave a manifest behind for the app to trust.
    expect(() => readFileSync(outPath, 'utf8')).toThrow()
  })

  it('refuses to upload when it has not been told where the manifest goes', async () => {
    const dir = makeWeightsDir()
    let uploadCalls = 0
    await expect(
      publish({
        specPath: writeSpec(dir),
        upload: true,
        deps: depsWith({
          uploadAsset: () => {
            uploadCalls += 1
          }
        })
      })
    ).rejects.toMatchObject({ reason: 'out-missing' })
    expect(uploadCalls).toBe(0)
  })
})

describe('verifyManifestAgainstDirectory', () => {
  const manifestFor = async (stagingDir: string): Promise<ReturnType<typeof JSON.parse>> =>
    (await buildManifest({ specPath: writeSpec(stagingDir) })).manifest

  it('passes a directory that holds the exact bytes the manifest names', async () => {
    const manifest = await manifestFor(makeWeightsDir())
    await expect(
      verifyManifestAgainstDirectory({ manifest, dir: makeAssetsDir() })
    ).resolves.toEqual([])
  })

  it('catches a single changed byte, and catches a short file, by re-hashing and re-measuring', async () => {
    const manifest = await manifestFor(makeWeightsDir())
    const dir = makeAssetsDir()

    const changed = Buffer.from(DOC_BYTES)
    changed[0] = changed[0] ^ 0x01
    writeFileSync(join(dir, 'doc-parse.onnx'), changed)
    const changedProblems = await verifyManifestAgainstDirectory({ manifest, dir })
    expect(changedProblems).toHaveLength(1)
    expect(changedProblems[0]).toMatchObject({ asset: 'doc-parse.onnx', field: 'sha256' })

    writeFileSync(join(dir, 'doc-parse.onnx'), DOC_BYTES.subarray(0, 4))
    const shortProblems = await verifyManifestAgainstDirectory({ manifest, dir })
    expect(shortProblems.map((problem) => problem.field).sort()).toEqual(['bytes', 'sha256'])
  })

  it('reports a missing asset as a problem rather than silently skipping the check', async () => {
    const manifest = await manifestFor(makeWeightsDir())
    const dir = makeAssetsDir()
    rmSync(join(dir, 'ocsr-v2.onnx'))

    const problems = await verifyManifestAgainstDirectory({ manifest, dir })
    expect(problems).toEqual([
      { asset: 'ocsr-v2.onnx', field: 'file', message: `missing from ${dir}` }
    ])
  })

  it('reports a malformed manifest and produces no asset verdicts from it', async () => {
    const manifest = await manifestFor(makeWeightsDir())
    const dir = makeAssetsDir()
    manifest.entries[0].sha256 = 'nope'

    const problems = await verifyManifestAgainstDirectory({ manifest, dir })
    // The files on disk are perfect; the manifest is not. "Not checked" must not read as a pass.
    expect(
      problems.some((problem) => problem.asset === 'doc-parse.onnx' && problem.field === 'sha256')
    ).toBe(true)
    expect(problems.every((problem) => problem.message.includes('64 lowercase hex'))).toBe(true)
  })
})

describe('the uploader hands gh what the manifest promises', () => {
  // A local file whose own name is not the name we publish. gh names an asset after the file it is given,
  // so this is the case where the upload can silently create a different name than the manifest's URL.
  const renamedFile = (): string => {
    const dir = makeRoot()
    const path = join(dir, 'ocsr.onnx')
    writeFileSync(path, OCSR_BYTES)
    return path
  }

  it('uploads the file as-is when it already carries the published name', async () => {
    const dir = makeRoot()
    const path = join(dir, 'doc-parse.onnx')
    writeFileSync(path, DOC_BYTES)
    const calls: string[][] = []

    await createUploadAsset({ run: (args: string[]) => void calls.push(args) })({
      repo: 'naiyixi/PureScience',
      tag: 'models-v1',
      file: path,
      name: basename(path)
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual([
      'release',
      'upload',
      'models-v1',
      path,
      '--repo',
      'naiyixi/PureScience'
    ])
    // Nothing was staged, so nothing had to be cleaned: the author's file is still exactly where it was.
    expect(existsSync(path)).toBe(true)
  })

  it('stages a byte-identical copy under the published name and removes it afterwards', async () => {
    const path = renamedFile()
    let uploaded = ''
    // The bytes are read *while the upload runs*: the staging area is deliberately gone by the time the
    // call returns, so asserting afterwards would only prove the cleanup happened, not what was cleaned.
    let uploadedBytes: Buffer | null = null

    await createUploadAsset({
      run: (args: string[]) => {
        uploaded = args[3]
        uploadedBytes = readFileSync(args[3])
      }
    })({ repo: 'naiyixi/PureScience', tag: 'models-v1', file: path, name: 'ocsr-v2.onnx' })

    expect(basename(uploaded)).toBe('ocsr-v2.onnx')
    expect(uploadedBytes).toEqual(OCSR_BYTES)
    // The staged copy is gone; the original is untouched, byte for byte.
    expect(existsSync(dirname(uploaded))).toBe(false)
    expect(readFileSync(path)).toEqual(OCSR_BYTES)
  })

  it('removes the staged copy even when the upload fails — litter is not a side effect of an error', async () => {
    const path = renamedFile()
    let staged = ''

    const failure = createUploadAsset({
      run: (args: string[]) => {
        staged = args[3]
        throw new Error('gh exploded')
      }
    })({ repo: 'naiyixi/PureScience', tag: 'models-v1', file: path, name: 'ocsr-v2.onnx' })

    await expect(failure).rejects.toThrow('gh exploded')
    expect(staged).not.toBe('')
    expect(existsSync(staged)).toBe(false)
    expect(existsSync(dirname(staged))).toBe(false)
  })

  it('adds --clobber only when asked', async () => {
    const dir = makeRoot()
    const path = join(dir, 'doc-parse.onnx')
    writeFileSync(path, DOC_BYTES)
    const calls: string[][] = []

    await createUploadAsset({ run: (args: string[]) => void calls.push(args) })({
      repo: 'naiyixi/PureScience',
      tag: 'models-v1',
      file: path,
      name: basename(path),
      clobber: true
    })

    expect(calls[0]).toContain('--clobber')
  })
})

describe('the CLI entry point, run the way a human runs it', () => {
  // Why this block exists: a module-link error — a duplicated export, or a relative import one level too
  // deep — makes the whole file unusable to `node` while vitest still links it and every other test in
  // this file passes. The documented `npm run publish:model-weights` entry then does nothing but crash,
  // and no gate in this repo sees it (eslint and tsc do not link an `.mjs`). Verified: a duplicated
  // export did exactly that, and this is the check that would have caught it.
  const cliPath = fileURLToPath(new URL('./publish-model-weights.mjs', import.meta.url))

  const runCli = (args: string[]): { status: number | null; stdout: string; stderr: string } => {
    const result = spawnSync(
      process.execPath,
      ['--no-warnings=MODULE_TYPELESS_PACKAGE_JSON', cliPath, ...args],
      { encoding: 'utf8' }
    )
    return { status: result.status, stdout: result.stdout, stderr: result.stderr }
  }

  it('loads at all: --help prints the usage and exits 0', () => {
    const result = runCli(['--help'])

    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('--spec <spec.json>')
  })

  it('publishes offline: a spec prints the manifest it would ship, exit 0', () => {
    const dir = makeWeightsDir()
    const result = runCli(['--spec', writeSpec(dir)])

    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    const printed = JSON.parse(result.stdout) as { entries: { id: string; sha256: string }[] }
    expect(printed.entries.map((entry) => entry.id)).toEqual(['doc-parse-primary', 'ocsr-primary'])
    // The digest in what it printed is ours, computed over the real bytes on disk.
    expect(printed.entries[1].sha256).toBe(digestOf(OCSR_BYTES))
  })

  it('refuses with a non-zero code, names the reason, and writes no manifest', () => {
    const dir = makeWeightsDir()
    // Two entries claiming one asset name: two identities for the same bytes.
    const specPath = writeSpec(dir, {
      entries: [
        {
          id: 'doc-parse-primary',
          revision: 'abc123',
          kind: 'document-parse',
          license: 'Apache-2.0',
          file: 'doc-parse.onnx'
        },
        {
          id: 'ocsr-primary',
          revision: 'def456',
          kind: 'structure-recognition',
          license: 'MIT',
          file: 'ocsr.onnx',
          assetName: 'doc-parse.onnx'
        }
      ]
    })
    const outPath = join(dir, 'manifest.json')
    const result = runCli(['--spec', specPath, '--out', outPath])

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('refused (asset-name-duplicated)')
    expect(existsSync(outPath)).toBe(false)
  })
})
