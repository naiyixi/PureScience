// On-demand engine weights (v1.57 unit 5): nothing is ever bundled, and nothing is downloaded
// without an explicit approval and a published checksum to verify it against.
//
// Two rules shape this module:
//   * an unresolved spec is a refusal. If we do not have a published SHA256 for the weights, we do
//     not fetch them — "we could not verify it" must never degrade into "we downloaded it anyway".
//   * the cache is only trusted after re-hashing. A file that exists but fails the checksum is
//     treated as absent and removed, so a truncated or tampered download can never be loaded.

import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export type WeightSpec = {
  modelId: string
  url: string
  bytes: number
  /** Published SHA256 of the artifact (lowercase hex). Required — never optional. */
  sha256: string
  license: string
}

export type WeightDownloadOutcome =
  | { status: 'cached'; path: string; spec: WeightSpec; verifiedSha256: string }
  | { status: 'downloaded'; path: string; spec: WeightSpec; verifiedSha256: string }
  | { status: 'needs-consent'; spec: WeightSpec; message: string }
  | { status: 'unresolved'; modelId: string; message: string }
  | {
      status: 'checksum-mismatch'
      spec: WeightSpec
      expectedSha256: string
      actualSha256: string
      message: string
    }
  | { status: 'failed'; modelId: string; message: string }

export type WeightFetcher = (url: string) => Promise<Uint8Array>

const isHex64 = (value: string): boolean => /^[0-9a-f]{64}$/.test(value)

export const sha256Of = (data: Uint8Array): string =>
  createHash('sha256').update(data).digest('hex')

export const modelWeightPath = (cacheDir: string, modelId: string): string =>
  join(cacheDir, 'engine-weights', `${modelId}`, 'weights.bin')

/** Refuses to plan a download without a published checksum or without the user's approval. */
export const downloadModelWeights = async (input: {
  modelId: string
  cacheDir: string
  specs: readonly WeightSpec[]
  /** Explicit user approval for *this* download. */
  consent: boolean
  fetchWeights: WeightFetcher
}): Promise<WeightDownloadOutcome> => {
  const spec = input.specs.find((candidate) => candidate.modelId === input.modelId)
  if (!spec) {
    return {
      status: 'unresolved',
      modelId: input.modelId,
      message: `没有 ${input.modelId} 的权重规格（URL/体积/SHA256）。未获已发布校验和前不会下载；请先补充规格或明确报告"未计算"。`
    }
  }
  if (!isHex64(spec.sha256)) {
    return {
      status: 'unresolved',
      modelId: input.modelId,
      message: `权重规格里的 SHA256 不是 64 位十六进制（${spec.sha256}）：视为未解析，拒绝下载。`
    }
  }
  if (!input.consent) {
    return {
      status: 'needs-consent',
      spec,
      message: `未获同意：不下载 ${spec.modelId} 的权重（约 ${spec.bytes} 字节，许可 ${spec.license}）。`
    }
  }

  const path = modelWeightPath(input.cacheDir, input.modelId)
  const cached = await readIfVerified(path, spec.sha256)
  if (cached) {
    return { status: 'cached', path, spec, verifiedSha256: cached }
  }

  let payload: Uint8Array
  try {
    payload = await input.fetchWeights(spec.url)
  } catch (cause) {
    return {
      status: 'failed',
      modelId: input.modelId,
      message: `权重下载失败（${cause instanceof Error ? cause.message : String(cause)}）：未缓存，请重试或在有网络的主机上运行。`
    }
  }

  const actualSha256 = sha256Of(payload)
  if (actualSha256 !== spec.sha256) {
    return {
      status: 'checksum-mismatch',
      spec,
      expectedSha256: spec.sha256,
      actualSha256,
      message: `校验和不匹配（期望 ${spec.sha256}，实际 ${actualSha256}）：已丢弃下载内容，绝不加载未经验证的权重。`
    }
  }

  try {
    await mkdir(dirname(path), { recursive: true })
    const temporary = `${path}.partial`
    await writeFile(temporary, payload)
    await rename(temporary, path)
  } catch (cause) {
    return {
      status: 'failed',
      modelId: input.modelId,
      message: `权重写入缓存失败（${cause instanceof Error ? cause.message : String(cause)}）。`
    }
  }

  return { status: 'downloaded', path, spec, verifiedSha256: actualSha256 }
}

/** Returns the verified digest when the cached file matches, otherwise removes it and returns null. */
const readIfVerified = async (path: string, expectedSha256: string): Promise<string | null> => {
  try {
    await stat(path)
  } catch {
    return null
  }
  try {
    const data = await readFile(path)
    const digest = sha256Of(new Uint8Array(data))
    if (digest === expectedSha256) return digest
    await rm(path, { force: true })
    return null
  } catch {
    return null
  }
}
