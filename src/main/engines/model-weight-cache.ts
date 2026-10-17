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
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import type { EngineWeightSpec } from '../../shared/engine-weights'
import { streamWithMirrorFallback, type StreamAttempt } from '../net/source-mirrors'

/** The spec shape is owned by `shared/engine-weights` (the build-level list of what may be downloaded);
 *  this module only fetches against it, so the two cannot drift into two vocabularies. */
export type WeightSpec = EngineWeightSpec

export type WeightDownloadOutcome =
  | { status: 'cached'; path: string; spec: WeightSpec; verifiedSha256: string }
  | {
      status: 'downloaded'
      path: string
      spec: WeightSpec
      verifiedSha256: string
      /** Which host actually served the bytes: `'origin'`, or the mirror that had to be used. */
      via?: string
    }
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

/**
 * Streams `url` into `destPath`. The caller owns `destPath` (a partial file), including its removal.
 *
 * The third argument is what makes a mirror fallback legitimate: a caller that holds the published digest
 * passes it in, and the streamer may then fall back to a measured mirror after the origin fails. A caller
 * that passes no digest gets the origin only. The resolved value names where the bytes came from
 * (`'origin'` or a mirror host); a stub that returns nothing is read as the origin.
 */
export type WeightStreamer = (
  url: string,
  destPath: string,
  opts?: { expectedSha256?: string }
) => Promise<string | void>

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
    // The digest goes in so the streamer may fall back to a measured mirror after the origin fails; the
    // verification below is what makes that fallback safe, and it runs on the landed file either way.
    const via = await input.streamWeights(spec.url, partial, { expectedSha256: spec.sha256 })
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
    return {
      status: 'downloaded',
      path,
      spec,
      verifiedSha256: actualSha256,
      ...(via ? { via } : {})
    }
  } catch (cause) {
    // Whatever went wrong, the partial file must not survive: a half-written weight that is later read as
    // "cached" is the exact failure this module exists to prevent.
    await rm(partial, { force: true })
    return {
      status: 'failed',
      modelId: input.modelId,
      message:
        `权重流式下载失败（${describeFetchFailure(cause)}）：未缓存，且已清除临时文件。` +
        `可在「设置 → 网络」里配置代理后重试；若本机直连不到该地址，也可手动下载后放到 ${path} 再重试。`
    }
  }
}

/**
 * 说清「哪一类失败」，而不是把客户端的 `fetch failed` 原样端给用户：不可达、被拒、超时、证书、被重置
 * 各是一条不同的结论，下一步也不同（配代理 / 换网络 / 手动放文件）。
 */
const describeFetchFailure = (cause: unknown): string => {
  const raw = cause instanceof Error ? cause.message : String(cause)
  const code = (cause as { code?: string } | null)?.code ?? ''
  const text = `${code} ${raw}`
  if (/ENOTFOUND|EAI_AGAIN|ERR_NAME_NOT_RESOLVED/i.test(text)) return `域名解析不了（${raw}）`
  if (/ECONNREFUSED|ERR_CONNECTION_REFUSED/i.test(text)) return `连接被拒绝（${raw}）`
  if (/ETIMEDOUT|ERR_TIMED_OUT|ERR_CONNECTION_TIMED_OUT|timeout/i.test(text))
    return `连接超时（${raw}）`
  if (/CERT|TLS|SSL/i.test(text)) return `TLS 或证书问题（${raw}）`
  if (/ECONNRESET|ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED/i.test(text))
    return `连接被重置（${raw}）`
  return raw
}

/**
 * Fails a transfer that has stopped producing bytes.
 *
 * The nine-day log's dominant download failure was not an error — it was a connection that never finished.
 * A silent stall has no error to react to, so without this the mirror fallback would never fire in exactly
 * the case it exists for. Written as a stream stage (not as a whole-request timeout) because a 299 MB
 * transfer legitimately takes many minutes: the clock has to reset on every chunk, not run once.
 */
export const createStallGuard = (
  stallMs: number,
  onStall: () => void,
  timers: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout } = {
    setTimeout,
    clearTimeout
  }
): Transform => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const arm = (): void => {
    if (timer) timers.clearTimeout(timer)
    timer = timers.setTimeout(() => {
      timer = undefined
      onStall()
    }, stallMs)
  }
  const disarm = (): void => {
    if (timer) timers.clearTimeout(timer)
    timer = undefined
  }
  arm()
  return new Transform({
    transform(chunk, _encoding, callback) {
      arm()
      callback(null, chunk)
    },
    flush(callback) {
      disarm()
      callback()
    },
    destroy(error, callback) {
      disarm()
      callback(error)
    }
  })
}

/** No bytes for this long ⇒ the connection is treated as failed, so the fallback can be reached. */
const STALL_TIMEOUT_MS = 30_000

const streamWithChromium = async (url: string, destPath: string): Promise<void> => {
  const electron = (await import('electron')) as unknown as {
    net?: {
      request: (url: string) => {
        on: (event: string, handler: (...args: unknown[]) => void) => void
        end: () => void
        abort: () => void
      }
    }
  }
  const net = electron.net
  if (!net?.request) throw new Error('no-chromium-net')
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const settle = (finish: () => void): void => {
      if (settled) return
      settled = true
      finish()
    }
    const request = net.request(url)
    const guard = createStallGuard(STALL_TIMEOUT_MS, () => {
      try {
        request.abort()
      } catch {
        // The request may already be torn down; the rejection below is what matters.
      }
      settle(() =>
        reject(new Error(`停滞超时：${STALL_TIMEOUT_MS / 1000} 秒内没有收到任何字节（${url}）`))
      )
    })
    request.on('response', (rawResponse) => {
      const response = rawResponse as { statusCode: number; statusMessage?: string }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        settle(() =>
          reject(new Error(`HTTP ${response.statusCode} ${response.statusMessage ?? ''}`.trim()))
        )
        return
      }
      void pipeline(
        rawResponse as unknown as NodeJS.ReadableStream,
        guard,
        createWriteStream(destPath)
      ).then(
        () => settle(resolve),
        (error) => settle(() => reject(error as Error))
      )
    })
    // Chromium reports a failure with its own sentence (e.g. net::ERR_CONNECTION_RESET): keep it.
    request.on('error', (error) =>
      settle(() => reject(error instanceof Error ? error : new Error(String(error))))
    )
    request.end()
  })
}

const streamWithFetch = async (url: string, destPath: string): Promise<void> => {
  const controller = new AbortController()
  let stalled = false
  const guard = createStallGuard(STALL_TIMEOUT_MS, () => {
    stalled = true
    controller.abort()
  })
  const response = await fetch(url, { signal: controller.signal })
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`)
  }
  if (!response.body) {
    throw new Error('响应没有可读的正文')
  }
  try {
    await pipeline(
      response.body as unknown as NodeJS.ReadableStream,
      guard,
      createWriteStream(destPath)
    )
  } catch (error) {
    if (stalled) {
      throw new Error(`停滞超时：${STALL_TIMEOUT_MS / 1000} 秒内没有收到任何字节（${url}）`)
    }
    throw error
  }
}

/**
 * Streams a URL to a file, one attempt against one host.
 *
 * **Which HTTP stack, and why it matters**: Node's `fetch` (undici) ignores both this app's proxy setting and
 * the operating system's proxy configuration, so on a proxied network this download had no route at all —
 * the user saw a bare `fetch failed` after clicking download on a 299 MB asset. Inside Electron we therefore
 * stream through **Chromium** (`net.request`), which honours the session proxy the settings layer applies;
 * outside Electron (unit tests, CLI) the global fetch is all there is.
 */
const streamOnce: StreamAttempt = async (url, destPath) => {
  try {
    await streamWithChromium(url, destPath)
    return
  } catch (error) {
    if (!(error instanceof Error) || error.message !== 'no-chromium-net') throw error
    // Not in Electron: fall through to the global fetch.
  }
  await streamWithFetch(url, destPath)
}

export const streamUrlToFile: WeightStreamer = async (url, destPath, opts) => {
  const { via } = await streamWithMirrorFallback(url, destPath, opts ?? {}, { stream: streamOnce })
  return via
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
