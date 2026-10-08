import { createHash } from 'node:crypto'

import {
  READING_FINGERPRINT_HASH_RECIPE,
  READING_FINGERPRINT_PREFIX,
  type ConnectorReadingFingerprint
} from '../../shared/reading-fingerprint'
import type { ConnectorCredentials, ToolContext, ToolDescriptor } from './types'

const DEFAULT_TIMEOUT_MS = 30_000

// Transient-failure retry policy shared by every connector call. Public bio APIs (PubChem PUG-REST,
// GTEx, NCBI) routinely return 429/5xx or a brief timeout under load; a couple of backed-off retries
// turn those blips into successes instead of surfacing them to the notebook.
const DEFAULT_RETRIES = 2
const DEFAULT_BACKOFF_MS = 400
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504])

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// Some public APIs (e.g. AlphaFold EBI) reject requests without a User-Agent; send a stable one.
const USER_AGENT =
  'Mozilla/5.0 (compatible; PureScience/1.0; +https://github.com/zerolink/purescience)'

// Builds the NCBI E-utilities etiquette query suffix; empty when unset (calls still work).
export function ncbiEtiquette(credentials: ConnectorCredentials): string {
  const parts: string[] = []
  if (credentials.ncbiEmail) parts.push(`email=${encodeURIComponent(credentials.ncbiEmail)}`)
  if (credentials.ncbiApiKey) parts.push(`api_key=${encodeURIComponent(credentials.ncbiApiKey)}`)
  return parts.length ? `&${parts.join('&')}` : ''
}

// Strips credential query params (NCBI email/api_key) from a URL before it can land in an error
// message or log. Falls back to the raw string if it doesn't parse as a URL.
function redactUrl(url: string): string {
  try {
    const parsed = new URL(url)
    parsed.searchParams.delete('email')
    parsed.searchParams.delete('api_key')
    return parsed.toString()
  } catch {
    return url
  }
}

// Generic executor shared by every connector: declarative { url, parse } or a run() escape hatch.
export class ParserEngine {
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number
  private readonly retries: number
  private readonly backoffMs: number
  private readonly subAgent?: ToolContext['runSubAgent']

  constructor(opts?: {
    fetchImpl?: typeof fetch
    timeoutMs?: number
    retries?: number
    retryBackoffMs?: number
    subAgent?: ToolContext['runSubAgent']
  }) {
    this.fetchImpl = opts?.fetchImpl ?? fetch
    this.timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.retries = opts?.retries ?? DEFAULT_RETRIES
    this.backoffMs = opts?.retryBackoffMs ?? DEFAULT_BACKOFF_MS
    this.subAgent = opts?.subAgent
  }

  async call(
    descriptor: ToolDescriptor,
    args: Record<string, unknown>,
    credentials: ConnectorCredentials,
    // Receives one fingerprint per HTTP response this call read. Optional, so a caller that only wants
    // the value pays nothing and behaves exactly as before.
    onReading?: (reading: ConnectorReadingFingerprint) => void
  ): Promise<unknown> {
    for (const key of descriptor.required ?? []) {
      if (args[key] == null) throw new Error(`missing required arg: ${key}`)
    }
    const ctx = this.makeContext(credentials, descriptor, onReading)
    if (descriptor.run) return descriptor.run(ctx, args)
    if (!descriptor.url || !descriptor.parse) {
      throw new Error(`descriptor ${descriptor.id} needs either run() or url()+parse()`)
    }
    const url = descriptor.url(args)
    const raw = descriptor.format === 'text' ? await ctx.fetchText(url) : await ctx.fetchJson(url)
    return descriptor.parse(raw, args)
  }

  private makeContext(
    credentials: ConnectorCredentials,
    descriptor: ToolDescriptor,
    onReading?: (reading: ConnectorReadingFingerprint) => void
  ): ToolContext {
    // Delay before the next attempt: honour a numeric Retry-After (seconds, capped), else exponential
    // backoff with jitter off the configured base.
    const nextDelay = (attempt: number, retryAfter: string | null): number => {
      const ra = retryAfter ? Number(retryAfter) : NaN
      if (Number.isFinite(ra) && ra >= 0) return Math.min(ra * 1000, 5_000)
      return Math.min(this.backoffMs * 2 ** attempt, 4_000) + Math.random() * this.backoffMs
    }

    // The response body AS BYTES, when the transport can hand them over — which a real fetch always can
    // and a test double usually cannot. `undefined` is not a failure: it means this transport has no byte
    // view, so no fingerprint can be taken and the caller keeps using the transport's own json()/text(),
    // exactly as before this module existed.
    type ReadBody = { bytes: Uint8Array; text: string }

    const readBody = async (res: Response): Promise<ReadBody | undefined> => {
      if (typeof (res as { arrayBuffer?: unknown }).arrayBuffer !== 'function') return undefined
      const bytes = new Uint8Array(await res.arrayBuffer())
      return { bytes, text: new TextDecoder().decode(bytes) }
    }

    // sha256 over the published recipe, the request, and the response bytes — the same composition a
    // verifier outside the app reproduces (see shared/reading-fingerprint.ts).
    const fingerprintBytes = (
      url: string,
      method: 'GET' | 'POST',
      status: number,
      bytes: Uint8Array
    ): string => {
      const digest = createHash('sha256')
        .update(`${READING_FINGERPRINT_HASH_RECIPE}\n${method}\n${redactUrl(url)}\n${status}\n`)
        .update(bytes)
        .digest('hex')
      return `${READING_FINGERPRINT_PREFIX}${digest}`
    }

    const doFetch = async (
      url: string,
      accept: string,
      init?: RequestInit
    ): Promise<{ res: Response; body: ReadBody | undefined }> => {
      const method: 'GET' | 'POST' = init?.method === 'POST' ? 'POST' : 'GET'
      for (let attempt = 0; ; attempt++) {
        const controller = new AbortController()
        // Deadline wins even if the transport ignores the abort signal: a stalled request must
        // fail fast with a clear explanation (timeouts are not retried), never hang until the
        // process-level timeout.
        let timer: ReturnType<typeof setTimeout> | undefined
        const deadline = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            controller.abort()
            reject(
              new Error(
                `Request timed out after ${this.timeoutMs}ms for ${redactUrl(url)} (deadline reached; not retried)`
              )
            )
          }, this.timeoutMs)
        })
        let res: Response
        try {
          res = await Promise.race([
            this.fetchImpl(url, {
              ...init,
              headers: { accept, 'user-agent': USER_AGENT, ...init?.headers },
              signal: controller.signal
            }),
            deadline
          ])
        } catch (err) {
          // A stalled request fails fast (deadline above); transient network errors (connection
          // refused, DNS, etc.) still retry with backoff.
          if (err instanceof Error && /timed out after/.test(err.message)) {
            throw err
          }
          if (attempt < this.retries) {
            await sleep(nextDelay(attempt, null))
            continue
          }
          throw err
        } finally {
          clearTimeout(timer)
        }
        if (res.ok) {
          const body = await readBody(res)
          // Recorded only from the received bytes. A transport that handed us no bytes gets no reading:
          // a digest of a re-serialisation would not reproduce against what the service actually sent,
          // and the verifier reports the absence as `not-recorded` rather than as a pass.
          if (onReading && body) {
            onReading({
              service: descriptor.connector,
              tool: descriptor.id,
              request: { method, url: redactUrl(url) },
              response: {
                status: res.status,
                bytes: body.bytes.byteLength,
                sha256: fingerprintBytes(url, method, res.status, body.bytes)
              }
            })
          }
          return { res, body }
        }
        // Retry only transient source statuses; client errors (4xx except 429) fail fast.
        if (attempt < this.retries && RETRYABLE_STATUS.has(res.status)) {
          await sleep(nextDelay(attempt, res.headers?.get?.('retry-after') ?? null))
          continue
        }
        throw new Error(`HTTP ${res.status} for ${redactUrl(url)}`)
      }
    }

    // Without a byte view the transport's own accessors are used, which is what every call did before
    // this module existed — so a transport that cannot be fingerprinted still behaves identically.
    const bodyText = async ({
      res,
      body
    }: {
      res: Response
      body: ReadBody | undefined
    }): Promise<string> => (body ? body.text : res.text())

    const bodyJson = async ({
      res,
      body
    }: {
      res: Response
      body: ReadBody | undefined
    }): Promise<unknown> => (body ? JSON.parse(body.text) : res.json())

    return {
      credentials,
      runSubAgent: this.subAgent,
      fetchJson: async (url) => bodyJson(await doFetch(url, 'application/json')),
      fetchJsonWithHeaders: async (url) => {
        const fetched = await doFetch(url, 'application/json')
        return { body: await bodyJson(fetched), headers: fetched.res.headers }
      },
      fetchText: async (url) => bodyText(await doFetch(url, 'text/plain, application/xml, */*')),
      postJson: async (url, body) =>
        bodyJson(
          await doFetch(url, 'application/json', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body)
          })
        )
    }
  }
}
