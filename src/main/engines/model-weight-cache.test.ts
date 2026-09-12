import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import {
  downloadModelWeights,
  modelWeightPath,
  sha256Of,
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
