import { describe, expect, it, vi } from 'vitest'

import { detectFunctionModelTarget } from './detect'

// A detection is only worth a button if it measures. These cases pin the two halves of that: a real request
// is actually sent, and every way it can fail comes back named.

const target = { baseUrl: 'https://configured.example/v1', key: 'k', model: 'small-model' }

const okResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })

describe('detectFunctionModelTarget', () => {
  it('sends one real request to the configured endpoint and reports what it cost', async () => {
    const fetchImpl = vi.fn(async () =>
      okResponse({
        choices: [{ message: { content: 'pong' } }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }
      })
    ) as unknown as typeof fetch

    const detection = await detectFunctionModelTarget({ target, fetchImpl })

    expect(detection.ok).toBe(true)
    if (!detection.ok) throw new Error('expected a successful detection')
    expect(detection.elapsedMs).toBeGreaterThanOrEqual(0)
    expect(detection.model).toBe('small-model')
    expect(detection.usage).toEqual({ inputTokens: 3, outputTokens: 2, totalTokens: 5 })

    const [url, init] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock
      .calls[0]
    expect(String(url)).toBe('https://configured.example/v1/chat/completions')
    expect((init.headers as Record<string, string>).authorization).toContain('k')
    expect(JSON.parse(String(init.body)).model).toBe('small-model')
  })

  it('reports a missing usage block as absent rather than as zero', async () => {
    const fetchImpl = vi.fn(async () =>
      okResponse({ choices: [{ message: { content: 'pong' } }] })
    ) as unknown as typeof fetch

    const detection = await detectFunctionModelTarget({ target, fetchImpl })

    expect(detection.ok).toBe(true)
    if (!detection.ok) throw new Error('expected a successful detection')
    // Zero tokens would be a measurement; an absent block is the provider not saying.
    expect(detection.usage).toBeUndefined()
  })

  it('names a refused request with its status', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('nope', { status: 404 })
    ) as unknown as typeof fetch

    await expect(detectFunctionModelTarget({ target, fetchImpl })).resolves.toMatchObject({
      ok: false,
      reason: 'http-error',
      status: 404
    })
  })

  it('refuses to call a 200 with no completion a working model', async () => {
    const fetchImpl = vi.fn(async () => okResponse({ choices: [] })) as unknown as typeof fetch

    await expect(detectFunctionModelTarget({ target, fetchImpl })).resolves.toMatchObject({
      ok: false,
      reason: 'invalid-response'
    })
  })

  it('names an unreachable endpoint', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch

    await expect(detectFunctionModelTarget({ target, fetchImpl })).resolves.toMatchObject({
      ok: false,
      reason: 'unreachable'
    })
  })

  it('names a timeout instead of hanging the settings page', async () => {
    const fetchImpl = vi.fn(
      async (_url: string, init?: RequestInit) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError'))
          )
        })
    ) as unknown as typeof fetch

    const detection = await detectFunctionModelTarget({ target, fetchImpl, timeoutMs: 5 })

    expect(detection.ok).toBe(false)
    if (detection.ok) throw new Error('expected a failed detection')
    expect(detection.reason).toBe('timeout')
  })
})
