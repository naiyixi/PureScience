// On-demand engine weights (v1.57 unit 5): nothing is ever bundled, and nothing is downloaded
// without an explicit approval and a published checksum to verify it against.
//
// Two rules shape this module:
//   * an unresolved spec is a refusal. If we do not have a published SHA256 for the weights, we do
//     not fetch them — "we could not verify it" must never degrade into "we downloaded it anyway".
//   * the cache is only trusted after re-hashing. A file that exists but fails the checksum is
//     treated as absent and removed, so a truncated or tampered download can never be loaded.
//
// v2.5.0 U3 adds a streaming path. The first artifact this app can actually fetch is ~298.7 MB, and the
// in-memory path held the whole payload (and re-read whole files to verify the cache) on a machine whose
// free physical memory is measured in tens of megabytes. The refusal rules are unchanged and are shared
// by both paths through `planWeightDownload`, so there is exactly one place that decides what may be
// downloaded — a second copy of those rules is how an "unresolved" spec eventually slips through.

import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'

import type { EngineWeightSpec } from '../../shared/engine-weights'

/** The spec shape is owned by `shared/engine-weights` (the build-level list of what may be downloaded);
 *  this module only fetches against it, so the two cannot drift into two vocabularies. */
export type WeightSpec = EngineWeightSpec

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

/** Streams `url` into `destPath`. The caller owns `destPath` (a partial file), including its removal. */
export type WeightStreamer = (url: string, destPath: string) => Promise<void>

const isHex64 = (value: string): boolean => /^[0-9a-f]{64}$/.test(value)

export const sha256Of = (data: Uint8Array): string =>
  createHash('sha256').update(data).digest('hex')

/** Hashes a file without holding it in memory, so a multi-hundred-megabyte weight can be verified. */
export const sha256OfFile = async (path: string): Promise<string> => {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

export const modelWeightPath = (cacheDir: string, modelId: string): string =>
  join(cacheDir, 'engine-weights', `${modelId}`, 'weights.bin')

/** The partial file a download writes to before it is allowed to become `modelWeightPath`. */
export const modelWeightPartialPath = (cacheDir: string, modelId: string): string =>
  `${modelWeightPath(cacheDir, modelId)}.partial`

/**
 * The one place that decides whether a download may start. Both the in-memory and the streaming path ask
 * it, so the two cannot disagree about what "unresolved" or "needs consent" means.
 */
type WeightDownloadPlan =
  { ok: true; spec: WeightSpec; path: string } | { ok: false; outcome: WeightDownloadOutcome }

const planWeightDownload = (input: {
  modelId: string
  cacheDir: string
  specs: readonly WeightSpec[]
  consent: boolean
}): WeightDownloadPlan => {
  const spec = input.specs.find((candidate) => candidate.modelId === input.modelId)
  if (!spec) {
    return {
      ok: false,
      outcome: {
        status: 'unresolved',
        modelId: input.modelId,
        message: `没有 ${input.modelId} 的权重规格（URL/体积/SHA256）。未获已发布校验和前不会下载；请先补充规格或明确报告"未计算"。`
      }
    }
  }
  if (!isHex64(spec.sha256)) {
    return {
      ok: false,
      outcome: {
        status: 'unresolved',
        modelId: input.modelId,
        message: `权重规格里的 SHA256 不是 64 位十六进制（${spec.sha256}）：视为未解析，拒绝下载。`
      }
    }
  }
  if (!input.consent) {
    return {
      ok: false,
      outcome: {
        status: 'needs-consent',
        spec,
        message: `未获同意：不下载 ${spec.modelId} 的权重（约 ${spec.bytes} 字节，许可 ${spec.license}）。`
      }
    }
  }
  return { ok: true, spec, path: modelWeightPath(input.cacheDir, input.modelId) }
}

/** Refuses to plan a download without a published checksum or without the user's approval. */
export const downloadModelWeights = async (input: {
  modelId: string
  cacheDir: string
  specs: readonly WeightSpec[]
  /** Explicit user approval for *this* download. */
  consent: boolean
  fetchWeights: WeightFetcher
}): Promise<WeightDownloadOutcome> => {
  const plan = planWeightDownload(input)
  if (!plan.ok) return plan.outcome
  const { spec, path } = plan

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

/**
 * The same download, streamed to disk and hashed as it arrives: the payload is never held in memory.
 *
 * Nothing becomes a cached weight until the digest matches, and a run that fails or mismatches leaves the
 * directory exactly as it found it — a partial file is removed rather than left to be mistaken for a
 * download in progress. The refusal rules come from `planWeightDownload`, so this path cannot accept
 * something the in-memory path would refuse.
 */
export const downloadModelWeightsStreaming = async (input: {
  modelId: string
  cacheDir: string
  specs: readonly WeightSpec[]
  consent: boolean
  streamWeights: WeightStreamer
}): Promise<WeightDownloadOutcome> => {
  const plan = planWeightDownload(input)
  if (!plan.ok) return plan.outcome
  const { spec, path } = plan

  const cached = await readIfVerified(path, spec.sha256)
  if (cached) {
    return { status: 'cached', path, spec, verifiedSha256: cached }
  }

  const partial = modelWeightPartialPath(input.cacheDir, input.modelId)
  try {
    await mkdir(dirname(path), { recursive: true })
    await input.streamWeights(spec.url, partial)
    const actualSha256 = await sha256OfFile(partial)
    if (actualSha256 !== spec.sha256) {
      await rm(partial, { force: true })
      return {
        status: 'checksum-mismatch',
        spec,
        expectedSha256: spec.sha256,
        actualSha256,
        message: `校验和不匹配（期望 ${spec.sha256}，实际 ${actualSha256}）：已删除下载的临时文件，绝不加载未经验证的权重。`
      }
    }
    await rename(partial, path)
    return { status: 'downloaded', path, spec, verifiedSha256: actualSha256 }
  } catch (cause) {
    // Whatever went wrong, the partial file must not survive: a half-written weight that is later read as
    // "cached" is the exact failure this module exists to prevent.
    await rm(partial, { force: true })
    return {
      status: 'failed',
      modelId: input.modelId,
      message: `权重流式下载失败（${cause instanceof Error ? cause.message : String(cause)}）：未缓存，且已清除临时文件。`
    }
  }
}

/** Streams a URL to a file. Uses the global fetch, which is available in this Electron main process. */
export const streamUrlToFile: WeightStreamer = async (url, destPath) => {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`)
  }
  if (!response.body) {
    throw new Error('响应没有可读的正文')
  }
  await pipeline(response.body as unknown as NodeJS.ReadableStream, createWriteStream(destPath))
}

/** Returns the verified digest when the cached file matches, otherwise removes it and returns null. */
const readIfVerified = async (path: string, expectedSha256: string): Promise<string | null> => {
  try {
    await stat(path)
  } catch {
    return null
  }
  try {
    // Hashed from disk, not from memory: the cached file can be far larger than this process should hold.
    const digest = await sha256OfFile(path)
    if (digest === expectedSha256) return digest
    await rm(path, { force: true })
    return null
  } catch {
    return null
  }
}
