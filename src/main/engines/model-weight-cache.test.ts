import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import {
  downloadModelWeights,
  downloadModelWeightsStreaming,
  modelWeightPartialPath,
  modelWeightPath,
  sha256Of,
  sha256OfFile,
  type WeightSpec
} from './model-weight-cache'

const payload = new TextEncoder().encode('pretend esmfold weights')
const spec: WeightSpec = {
  modelId: 'esmfold',
  url: 'https://example.invalid/esmfold.bin',
  bytes: payload.byteLength,
  sha256: sha256Of(payload),
  license: 'MIT'
}

const cacheDir = async (): Promise<string> => mkdtemp(join(tmpdir(), 'ps-weights-'))

describe('on-demand engine weights', () => {
  it('refuses to download without the user’s consent', async () => {
    const fetchWeights = vi.fn()
    const outcome = await downloadModelWeights({
      modelId: 'esmfold',
      cacheDir: await cacheDir(),
      specs: [spec],
      consent: false,
      fetchWeights
    })
    expect(outcome.status).toBe('needs-consent')
    expect(fetchWeights).not.toHaveBeenCalled()
  })

  it('refuses when there is no pinned spec or the checksum is not a real digest', async () => {
    const fetchWeights = vi.fn()
    const missing = await downloadModelWeights({
      modelId: 'esmfold',
      cacheDir: await cacheDir(),
      specs: [],
      consent: true,
      fetchWeights
    })
    expect(missing.status).toBe('unresolved')

    const bogus = await downloadModelWeights({
      modelId: 'esmfold',
      cacheDir: await cacheDir(),
      specs: [{ ...spec, sha256: 'TBD' }],
      consent: true,
      fetchWeights
    })
    expect(bogus.status).toBe('unresolved')
    if (bogus.status !== 'unresolved') return
    expect(bogus.message).toContain('拒绝下载')
    expect(fetchWeights).not.toHaveBeenCalled()
  })

  it('downloads, verifies and caches, then reuses the verified file without re-downloading', async () => {
    const dir = await cacheDir()
    const fetchWeights = vi.fn(async () => payload)
    const first = await downloadModelWeights({
      modelId: 'esmfold',
      cacheDir: dir,
      specs: [spec],
      consent: true,
      fetchWeights
    })
    expect(first.status).toBe('downloaded')
    if (first.status !== 'downloaded') return
    expect(first.verifiedSha256).toBe(spec.sha256)
    expect(new Uint8Array(await readFile(first.path))).toEqual(payload)

    const second = await downloadModelWeights({
      modelId: 'esmfold',
      cacheDir: dir,
      specs: [spec],
      consent: true,
      fetchWeights
    })
    expect(second.status).toBe('cached')
    expect(fetchWeights).toHaveBeenCalledTimes(1)
  })

  it('discards a download whose checksum does not match', async () => {
    const dir = await cacheDir()
    const outcome = await downloadModelWeights({
      modelId: 'esmfold',
      cacheDir: dir,
      specs: [spec],
      consent: true,
      fetchWeights: async () => new TextEncoder().encode('tampered payload')
    })
    expect(outcome.status).toBe('checksum-mismatch')
    if (outcome.status !== 'checksum-mismatch') return
    expect(outcome.expectedSha256).toBe(spec.sha256)
    expect(JSON.stringify(outcome)).not.toContain('cached')
    await expect(readFile(modelWeightPath(dir, 'esmfold'))).rejects.toThrow()
  })

  it('treats a corrupted cache entry as absent and re-downloads it', async () => {
    const dir = await cacheDir()
    const path = modelWeightPath(dir, 'esmfold')
    await writeFile(path, 'corrupted').catch(async () => {
      const { mkdir } = await import('node:fs/promises')
      await mkdir(join(dir, 'engine-weights', 'esmfold'), { recursive: true })
      await writeFile(path, 'corrupted')
    })
    const outcome = await downloadModelWeights({
      modelId: 'esmfold',
      cacheDir: dir,
      specs: [spec],
      consent: true,
      fetchWeights: async () => payload
    })
    expect(outcome.status).toBe('downloaded')
  })

  it('reports a fetch failure without pretending the weights exist', async () => {
    const outcome = await downloadModelWeights({
      modelId: 'esmfold',
      cacheDir: await cacheDir(),
      specs: [spec],
      consent: true,
      fetchWeights: async () => {
        throw new Error('network down')
      }
    })
    expect(outcome.status).toBe('failed')
    if (outcome.status !== 'failed') return
    expect(outcome.message).toContain('未缓存')
  })
})

// v2.5.0 U3: the streaming path. The payload is never held in memory, so these cases assert on what is on
// disk afterwards — a partial file that survives a failure is the exact defect this path must not have.
describe('downloadModelWeightsStreaming', () => {
  const streamPayload = new TextEncoder().encode('pretend local parsing model weights')
  const streamSpec: WeightSpec = {
    modelId: 'structure-recognition-primary',
    url: 'https://example.invalid/models.zip',
    bytes: streamPayload.byteLength,
    sha256: sha256Of(streamPayload),
    license: 'CC-BY-4.0'
  }
  const specs = [streamSpec] as const

  const exists = async (path: string): Promise<boolean> => {
    try {
      await readFile(path)
      return true
    } catch {
      return false
    }
  }

  it('refuses a spec whose digest is not a published sha256, and streams nothing at all', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'mw-stream-'))
    const streamer = vi.fn(async () => undefined)
    const outcome = await downloadModelWeightsStreaming({
      modelId: streamSpec.modelId,
      cacheDir,
      specs: [{ ...streamSpec, sha256: 'NOT-A-DIGEST' }],
      consent: true,
      streamWeights: streamer
    })
    expect(outcome.status).toBe('unresolved')
    // The whole point: nothing was fetched. Not "fetched and discarded" — not fetched.
    expect(streamer).not.toHaveBeenCalled()
    expect(await exists(modelWeightPath(cacheDir, streamSpec.modelId))).toBe(false)
    expect(await exists(modelWeightPartialPath(cacheDir, streamSpec.modelId))).toBe(false)
  })

  it('refuses without consent, naming the size and the licence', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'mw-stream-'))
    const streamer = vi.fn(async () => undefined)
    const outcome = await downloadModelWeightsStreaming({
      modelId: streamSpec.modelId,
      cacheDir,
      specs,
      consent: false,
      streamWeights: streamer
    })
    expect(outcome.status).toBe('needs-consent')
    if (outcome.status !== 'needs-consent') return
    expect(outcome.message).toContain(String(streamSpec.bytes))
    expect(outcome.message).toContain('CC-BY-4.0')
    expect(streamer).not.toHaveBeenCalled()
  })

  it('leaves nothing behind when the transfer fails part-way', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'mw-stream-'))
    const outcome = await downloadModelWeightsStreaming({
      modelId: streamSpec.modelId,
      cacheDir,
      specs,
      consent: true,
      streamWeights: async (_url, dest) => {
        // A real interrupted transfer: bytes reached the disk, then the connection dropped.
        await writeFile(dest, streamPayload.subarray(0, 8))
        throw new Error('connection reset mid-transfer')
      }
    })
    expect(outcome.status).toBe('failed')
    if (outcome.status !== 'failed') return
    expect(outcome.message).toContain('已清除临时文件')
    expect(await exists(modelWeightPartialPath(cacheDir, streamSpec.modelId))).toBe(false)
    expect(await exists(modelWeightPath(cacheDir, streamSpec.modelId))).toBe(false)
  })

  it('removes the partial and reports both digests when the bytes do not match', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'mw-stream-'))
    const outcome = await downloadModelWeightsStreaming({
      modelId: streamSpec.modelId,
      cacheDir,
      specs,
      consent: true,
      streamWeights: async (_url, dest) => {
        await writeFile(dest, new TextEncoder().encode('tampered bytes pretending to be weights'))
      }
    })
    expect(outcome.status).toBe('checksum-mismatch')
    if (outcome.status !== 'checksum-mismatch') return
    expect(outcome.expectedSha256).toBe(streamSpec.sha256)
    expect(outcome.actualSha256).toBe(
      sha256Of(new TextEncoder().encode('tampered bytes pretending to be weights'))
    )
    expect(outcome.actualSha256).not.toBe(outcome.expectedSha256)
    expect(await exists(modelWeightPartialPath(cacheDir, streamSpec.modelId))).toBe(false)
    expect(await exists(modelWeightPath(cacheDir, streamSpec.modelId))).toBe(false)
  })

  it('verifies the digest of what actually landed on disk, then counts as cached without streaming again', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'mw-stream-'))
    const streamer = vi.fn(async (_url: string, dest: string) => {
      await writeFile(dest, streamPayload)
    })
    const first = await downloadModelWeightsStreaming({
      modelId: streamSpec.modelId,
      cacheDir,
      specs,
      consent: true,
      streamWeights: streamer
    })
    expect(first.status).toBe('downloaded')
    if (first.status !== 'downloaded') return
    // The digest came from the file on disk, not from the bytes we thought we sent.
    expect(first.verifiedSha256).toBe(
      await sha256OfFile(modelWeightPath(cacheDir, streamSpec.modelId))
    )
    expect(first.verifiedSha256).toBe(streamSpec.sha256)
    expect(await exists(modelWeightPartialPath(cacheDir, streamSpec.modelId))).toBe(false)

    const second = await downloadModelWeightsStreaming({
      modelId: streamSpec.modelId,
      cacheDir,
      specs,
      consent: true,
      streamWeights: streamer
    })
    expect(second.status).toBe('cached')
    expect(streamer).toHaveBeenCalledTimes(1)
  })

  it('throws away a cached file whose bytes no longer match, then re-downloads', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'mw-stream-'))
    const path = modelWeightPath(cacheDir, streamSpec.modelId)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(
      path,
      new TextEncoder().encode('poisoned cache that no longer matches the digest')
    )
    const outcome = await downloadModelWeightsStreaming({
      modelId: streamSpec.modelId,
      cacheDir,
      specs,
      consent: true,
      streamWeights: async (_url, dest) => {
        await writeFile(dest, streamPayload)
      }
    })
    expect(outcome.status).toBe('downloaded')
    expect(sha256Of(await readFile(path))).toBe(streamSpec.sha256)
  })
})
