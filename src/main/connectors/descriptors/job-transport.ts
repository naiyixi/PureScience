import { createHash } from 'node:crypto'

// Shared transport for the sequence/structure job tools (UniProt id-mapping, EBI BLAST+, Clustal
// Omega and the read-only InterProScan view). Every one of them is a two-phase job: a job-creating
// POST (submit) followed by idempotent GETs (status, result).
//
// The shared engine's fetchJson/postJson cannot express either half honestly: postJson retries, and a
// retried submit creates a SECOND job the caller never polls to completion. So — exactly like
// zinc.ts and genes-reactome.ts before it — these tools talk to the remote API directly through the
// global fetch and keep the retry decision explicit per stage.
export const JOB_USER_AGENT = 'PureScience/1.0 (+https://github.com/zerolink/purescience)'

const DEFAULT_HTTP_TIMEOUT_MS = 30_000
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504])

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

export const sha256Hex = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex')

// Strips credential query params (a contact email, an NCBI API key) from a URL before it can land in
// an error message or a log — the same guarantee the shared engine gives for its own URLs. Falls back
// to the raw string when it does not parse as a URL, so nothing is silently dropped from the message.
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url)
    parsed.searchParams.delete('email')
    parsed.searchParams.delete('api_key')
    return parsed.toString()
  } catch {
    return url
  }
}

// Every failure this unit can raise is named, so a caller never has to read "it failed" and guess.
// The kind is the machine-checkable contract; the message names the specific detail.
export type RemoteFailureKind =
  // The remote refused the request — bad parameters, a rejected submission, or a transient 5xx/429 on
  // the non-retryable submit. Distinct from a network-level drop, which also lands here with "no response".
  | 'remote-rejected'
  // The remote answered but does not know the job id (expired, typo, or a different service).
  | 'job-not-found'
  // The remote ran the job and it ended in an error state (ERROR/FAILURE), so there is no result.
  | 'job-failed'
  // The poll deadline passed before the job finished; the job may still be running remotely.
  | 'timeout'
  // The job finished but the result document was empty — not "zero hits", which is a valid result.
  | 'empty-result'
  // The result exceeded the caller's byte cap; the cap is a guard, never a silent truncation.
  | 'response-too-large'
  // The response was well-formed HTTP but not the shape this tool's contract promises.
  | 'contract-changed'

export class RemoteFailure extends Error {
  constructor(
    readonly kind: RemoteFailureKind,
    message: string
  ) {
    super(message)
    this.name = 'RemoteFailure'
  }
}

export type HttpText = { status: number; ok: boolean; text: string; headers: Headers }

async function requestOnce(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  accept: string
): Promise<HttpText> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      ...init,
      headers: { accept, 'user-agent': JOB_USER_AGENT, ...(init.headers ?? {}) },
      signal: controller.signal
    })
    return { status: res.status, ok: res.ok, text: await res.text(), headers: res.headers }
  } finally {
    clearTimeout(timer)
  }
}

// Submit is non-idempotent: EXACTLY ONE attempt, never replayed (retry: false). A 5xx/429 or a
// network drop is surfaced as a named remote rejection so the caller can decide to re-run
// deliberately — the transport must never quietly create a duplicate job.
export async function submitOnce(
  url: string,
  fields: Record<string, string>,
  opts: { accept?: string; timeoutMs?: number } = {}
): Promise<HttpText> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS
  try {
    return await requestOnce(
      url,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(fields).toString()
      },
      timeoutMs,
      opts.accept ?? '*/*'
    )
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new RemoteFailure(
      'remote-rejected',
      `the remote refused the submission to ${redactUrl(url)} (no response): ${reason}. Submission is a single ` +
        `attempt by design — a retry would create a second job; wait for the source to recover and re-run deliberately.`
    )
  }
}

// Status/result reads are idempotent, so they retry a transient 429/5xx with backoff — the same policy
// the shared engine applies to every other connector. A non-retryable status is returned (not thrown)
// so each tool can name it in its own words.
export async function fetchTextRetrying(
  url: string,
  opts: { accept?: string; timeoutMs?: number; retries?: number; backoffMs?: number } = {}
): Promise<HttpText> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS
  const retries = opts.retries ?? 2
  const backoffMs = opts.backoffMs ?? 400
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await requestOnce(url, { method: 'GET' }, timeoutMs, opts.accept ?? '*/*')
      if (res.ok) return res
      if (attempt < retries && RETRYABLE_STATUS.has(res.status)) {
        await sleep(Math.min(backoffMs * 2 ** attempt, 4_000))
        continue
      }
      return res
    } catch (error) {
      if (attempt < retries) {
        await sleep(Math.min(backoffMs * 2 ** attempt, 4_000))
        continue
      }
      throw new RemoteFailure(
        'remote-rejected',
        `reading ${redactUrl(url)} failed with no response: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
  }
}

export const bytesOf = (text: string): number => Buffer.byteLength(text, 'utf8')

// A byte cap is a guard, never a silent truncation: exceeding it is a named failure that says how big
// the payload actually was and how to fetch it deliberately.
export function assertWithinByteCap(text: string, maxBytes: number, what: string): number {
  const bytes = bytesOf(text)
  if (bytes > maxBytes) {
    throw new RemoteFailure(
      'response-too-large',
      `${what} is ${bytes} bytes, over the ${maxBytes}-byte cap. Raise max_bytes to fetch it, or ask ` +
        `for a smaller result type.`
    )
  }
  return bytes
}

export function assertNonEmpty(text: string, what: string): void {
  if (text.trim() === '') {
    throw new RemoteFailure(
      'empty-result',
      `${what} came back empty (HTTP 200 with an empty body) — the job finished but produced nothing.`
    )
  }
}

export type ProvenanceJob = { job_id: string; n_http_requests: number }

// Fingerprint of a tool call: which connector+tool ran, with which parameters, over exactly which
// response bytes. The descriptors return this so a landed result can be traced back to the call that
// produced it ("connector id + query parameters + response fingerprint"), reusing the app's existing
// artifact provenance panel rather than a second bookkeeping store.
export type Provenance = {
  connector: string
  tool: string
  params: Record<string, unknown>
  response_sha256: string
  retrieved_at: string
  n_http_requests: number
  bytes_received: number
  jobs?: ProvenanceJob[]
}

const TRANSCRIPT_SEPARATOR = '\u0000'

// Records every response body this call received, in order, so the provenance fingerprint covers the
// exact bytes the answer was derived from.
export class JobTranscript {
  private readonly parts: string[] = []
  private requests = 0
  private bytes = 0

  record(text: string): void {
    this.parts.push(text)
    this.requests += 1
    this.bytes += bytesOf(text)
  }

  get nHttpRequests(): number {
    return this.requests
  }

  get bytesReceived(): number {
    return this.bytes
  }

  digest(): string {
    return sha256Hex(this.parts.join(TRANSCRIPT_SEPARATOR))
  }

  provenance(
    connector: string,
    tool: string,
    params: Record<string, unknown>,
    jobs?: ProvenanceJob[]
  ): Provenance {
    return {
      connector,
      tool,
      params,
      response_sha256: this.digest(),
      retrieved_at: new Date().toISOString(),
      n_http_requests: this.requests,
      bytes_received: this.bytes,
      ...(jobs && jobs.length > 0 ? { jobs } : {})
    }
  }
}
